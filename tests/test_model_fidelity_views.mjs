import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createAttempt } from '../lib/model-fidelity/attempts.mjs';
import { projectView, renderView } from '../lib/model-fidelity/views.mjs';

const digest = 'a'.repeat(64);
const view = { schema: 'model-fidelity.view.v1', bundleDigest: digest, viewId: 'lifecycle', mode: 'light', states: [
  { id: 'build', label: 'Build', regionPath: ['worker'], hierarchyPath: ['delivery'] },
  { id: 'undo', label: 'Undo' },
], transitions: [{ from: 'build', to: 'undo', label: 'change wrong' }, { from: 'undo', to: 'undo', label: 'retry', condition: 'same generation' }], findings: ['F1'], omittedViews: [{ viewId: 'action-map', status: 'not-applicable', reason: 'Light mode' }, { viewId: 'fault-window', status: 'not-applicable', reason: 'Light mode' }], hiddenSteps: [], grouping: {} };
const findings = [{ id: 'F1', stateId: 'undo', mark: 'UNPROVEN STEP', message: 'Check before effect', evidenceIds: ['E1'] }];
async function fixture() {
  await mkdir('.scratch', { recursive: true });
  const root = await mkdtemp(path.resolve('.scratch/mf-view-test-'));
  const claim = await createAttempt({ storeRoot: root, unitId: 'u', attemptId: 'a', owner: 'worker' });
  return { root, claim };
}
const base = root => path.join(root, 'units/u/attempts/a/views/lifecycle');

// Why: the display cannot erase a repeating path or conceal a confirmed stop edge.
test('golden lifecycle projection retains loop, underlying IDs, regions, badges and both red-line paths', () => {
  const output = projectView(view, { findings });
  assert.deepEqual(output.sidecar.occurrences.map(o => o.stateId), ['undo']);
  assert.deepEqual(output.sidecar.originalTransitions, view.transitions);
  assert.equal(output.source.edges.some(e => e.from === e.to), false);
  assert.equal(output.source.edges.filter(e => e.to === 'red-line-hit').length, 2);
  assert.match(output.text, /UNPROVEN STEP \[F1\].*Evidence: E1/);
  assert.match(output.text, /action-map: not-applicable/);
  assert.match(output.source.nodes[0].lines.join(' '), /Region: worker/);
});

// Why: a diagram must not imply checks or runtime observations that did not happen.
test('results projection keeps checks, controls, runtime and gaps in source and text', () => {
  const output = projectView({ ...view, viewId: 'results' }, { checks: [{ bound: 42, status: 'incomplete' }], controls: [{ id: 'C1', status: 'not-run' }], findings, runtime: 'not-run' });
  assert.match(JSON.stringify(output.source), /RUNTIME NOT RUN/);
  assert.match(JSON.stringify(output.sidecar), /42/);
  assert.match(output.text, /Gaps/);
});

// Why: successful rendering must keep inspectable themes and append-only generations.
test('real strict render publishes inspectable HTML and both SVG themes; two results coexist', async () => {
  const { root, claim } = await fixture();
  for (const resultId of ['r1', 'r2']) {
    const result = await renderView(claim, { view, resultId, findings });
    assert.equal(result.status, 'rendered', JSON.stringify(result));
  }
  for (const resultId of ['r1', 'r2']) {
    const dir = path.join(base(root), resultId);
    assert.match(await readFile(path.join(dir, 'diagram.html'), 'utf8'), /Red line hit/);
    for (const theme of ['light', 'dark']) {
      const svg = await readFile(path.join(dir, `diagram.${theme}.svg`), 'utf8');
      assert.match(svg, /UNPROVEN STEP|Red line hit/);
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'view.json'), 'utf8')).occurrences.map(o => o.stateId), ['undo']);
  }
  await assert.rejects(renderView(claim, { view, resultId: 'r1', findings }), { code: 'EEXIST' });
});

// Why: an unavailable renderer is a visible coverage gap, never a lost source record.
test('missing renderer publishes source, text, placeholder and unmet-diagram finding', async () => {
  const { root, claim } = await fixture();
  const result = await renderView(claim, { view, resultId: 'missing', findings, rendererPath: '/nonexistent/bowerbird.mjs' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.unmetDiagram, true);
  assert.equal(result.findings[0].code, 'diagram-unavailable');
  const dir = path.join(base(root), 'missing');
  assert.match(await readFile(path.join(dir, 'diagram.bower.json'), 'utf8'), /bowerbird\/v1/);
  assert.match(await readFile(path.join(dir, 'diagram.txt'), 'utf8'), /UNPROVEN STEP/);
  assert.match(await readFile(path.join(dir, 'placeholder.html'), 'utf8'), /Diagram unavailable/);
});
