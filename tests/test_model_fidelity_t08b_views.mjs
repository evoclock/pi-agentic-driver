import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createAttempt } from '../lib/model-fidelity/attempts.mjs';
import { projectView, renderView } from '../lib/model-fidelity/views.mjs';

const base = { schema: 'model-fidelity.view.v1', bundleDigest: 'a'.repeat(64), mode: 'protocol', states: [], transitions: [], findings: ['F1'], hiddenSteps: [], grouping: {} };
const map = { actionId: 'apply', kind: 'implementation', modelLocation: 'Spec.tla:20', actor: 'writer', session: 's1', privilege: 'write', realOperation: 'conditional update', sourceEvidenceIds: ['E1'], preconditions: ['clearance'], observedValue: 'generation', observedFrom: 'row', protectedInterval: 'same transaction', effectPoint: 'update row', assumptions: ['all reassignments use this store'] };
const findings = [{ id: 'F1', actionId: 'apply', mark: 'UNPROVEN STEP', message: 'An external reassignment may intervene', evidenceIds: ['E2'] }];
const schedule = { id: 'window-1', provenance: 'review-proposed', steps: [
  { stateId: 'clear', actionId: 'clear', phase: 'clearance', actor: 'writer', session: 's1' },
  { stateId: 'read', actionId: 'read', phase: 'observation', actor: 'writer', session: 's1' },
  { stateId: 'replace', actionId: 'replace', phase: 'interference', actor: 'other', session: 's2', evidenceIds: ['E3'] },
  { stateId: 'apply', actionId: 'apply', phase: 'effect', actor: 'writer', session: 's1', ruleIds: ['current-generation'] },
] };
async function fixture() {
  await mkdir('.scratch', { recursive: true });
  const root = await mkdtemp(path.resolve('.scratch/mf-t08b-test-'));
  return { root, claim: await createAttempt({ storeRoot: root, unitId: 'u', attemptId: 'a', owner: 'worker' }) };
}

// Why: a declared operation is inspectable without implying that a checker explored it.
test('declared action map shows operations, evidence and gaps without claiming exploration', () => {
  let result;
  assert.doesNotThrow(() => { result = projectView({ ...base, viewId: 'action-map' }, { actionMaps: [map], findings }); });
  assert.equal(result.sidecar.exploration, 'unexplored');
  assert.match(JSON.stringify(result.source), /UNEXPLORED.*E1/);
  assert.match(JSON.stringify(result.source), /conditional update/);
  assert.match(JSON.stringify(result.source), /UNPROVEN STEP \[F1\].*E2/);
  assert.match(result.text, /actor unknown|writer/);
  assert.match(projectView({ ...base, viewId: 'action-map' }).text, /UNEXPLORED/);
});

// Why: the check-to-effect schedule and its provenance must not be collapsed into one safe step.
test('fault windows preserve clearance, observation, interference, effect, origin and underlying IDs', () => {
  const result = projectView({ ...base, viewId: 'fault-window' }, { schedules: [schedule], findings });
  assert.deepEqual(result.sidecar.sourceStateIds, ['window-1:0', 'window-1:1', 'window-1:2', 'window-1:3']);
  assert.deepEqual(result.sidecar.originalTransitions.map(t => t.label), ['observation', 'interference', 'effect']);
  assert.match(JSON.stringify(result.source), /Review-proposed path: window-1/);
  assert.match(JSON.stringify(result.source), /Underlying state: replace/);
  assert.match(JSON.stringify(result.source), /current-generation/);
  assert.throws(() => projectView({ ...base, viewId: 'fault-window' }, { schedules: [{ ...schedule, provenance: 'TLC-observed' }] }), /provenance/);
});

// Why: missing rendering must disclose the gap while retaining the original source and text.
test('both new views render strict HTML and light/dark SVG; failures retain source', async () => {
  const { root, claim } = await fixture();
  for (const [viewId, opts] of [['action-map', { actionMaps: [map] }], ['fault-window', { schedules: [schedule] }]]) {
    let result;
    await assert.doesNotReject(async () => { result = await renderView(claim, { view: { ...base, viewId }, resultId: 'r1', findings, ...opts }); });
    assert.equal(result.status, 'rendered', JSON.stringify(result));
    const dir = path.join(root, 'units/u/attempts/a/views', viewId, 'r1');
    assert.match(await readFile(path.join(dir, 'diagram.html'), 'utf8'), /UNPROVEN STEP/);
    for (const theme of ['light', 'dark']) assert.match(await readFile(path.join(dir, `diagram.${theme}.svg`), 'utf8'), /UNPROVEN STEP/);
    assert.match(await readFile(path.join(dir, 'view.json'), 'utf8'), /"exploration"/);
  }
  const missing = await renderView(claim, { view: { ...base, viewId: 'action-map' }, resultId: 'missing', rendererPath: '/nonexistent/renderer.mjs' });
  assert.equal(missing.unmetDiagram, true);
  assert.equal(missing.findings[0].code, 'diagram-unavailable');
});
