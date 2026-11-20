import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../docs/design/workflow-runner/', import.meta.url);
const text = (name) => readFileSync(new URL(name, root), 'utf8');
const map = JSON.parse(text('action-map.json'));
const guards = {
  'unsafe-journal': ['JournalGuard', 'DispatchHasIntent'],
  'unsafe-dispatch': ['DispatchGuard', 'NoAdvanceWithoutDispatch'],
  'unsafe-epoch-stamp': ['EpochStampGuard', 'ResultEpochIsDispatchEpoch'],
  'unsafe-writer-stamp': ['WriterStampGuard', 'ResultWriterIsDispatchWriter'],
  'unsafe-readback': ['ReadbackGuard', 'NoBlindResend'],
  'unsafe-trust': ['TrustGuard', 'NoTrustedAdvance'],
  'unsafe-dispatch-id': ['DispatchIdGuard', 'NoOwnDispatchAdvance'],
  'unsafe-ack-resume': ['AckResumeGuard', 'NoUnackedResume'],
  'unsafe-ack-reconcile': ['AckReconcileGuard', 'NoAcknowledgedReadback'],
  'unsafe-cancel-phase': ['CancelPhaseGuard', 'NoCancelTerminal'],
  'unsafe-cancel-epoch': ['CancelEpochGuard', 'NoCancelEpochGap'],
};

// Why: Design-time diagram edges are not runtime transitions; execution edges must name real model actions.
test('composition design edges are n/a and execution edges have model actions', () => {
  const diagram = JSON.parse(text('workflow.bower.json'));
  const edges = diagram.composition.edges.map(({ from, to }) => `${from}->${to}`);
  assert.deepEqual(Object.keys(map.diagramEdges).sort(), edges.sort());
  for (const edge of ['task->plan', 'plan->poteto', 'plan->statechart']) {
    assert.equal(map.diagramEdges[edge], 'n/a', edge);
  }
  for (const [edge, actions] of Object.entries(map.diagramEdges)) {
    if (actions === 'n/a') continue;
    assert.ok(Array.isArray(actions) && actions.length, edge);
    for (const action of actions) {
      assert.match(text('WorkflowRunner.tla'), new RegExp(`^${action}\\s*==`, 'm'));
    }
  }
  for (const action of Object.keys(map.actions)) {
    assert.ok(Object.values(map.diagramEdges).some((actions) => Array.isArray(actions) && actions.includes(action)), action);
  }
});

// Why: This reads committed ack-conformance traces only; it does not rerun TLC or prove outcome necessity.
test('recorded ack conformance violations are present', () => {
  for (const [name, invariant] of [
    ['unsafe-ack-resume', 'NoUnackedResume'],
    ['unsafe-ack-reconcile', 'NoAcknowledgedReadback'],
  ]) {
    assert.match(text(`tlc-fix5-${name}.out`), new RegExp(`Error: Invariant ${invariant} is violated\\.`));
    assert.match(text('tlc-fix5-WorkflowRunner.out'), /Model checking completed\. No error has been found\./);
  }
});

// Why: Event and receipt examples must expose the provenance fields the verifier needs to bind effects.
test('contract documents the frozen step base and trusted actor and writer', () => {
  const contract = text('cli-contract.md');
  const blocks = [...contract.matchAll(/```json\n([^\n]+)\n```/g)].map(([, line]) => JSON.parse(line));
  const event = blocks.find((item) => item.schema === 'pad-workflow-event.v1');
  const receipt = blocks.find((item) => item.schema === 'pad-skill-receipt.v1');
  assert.ok(event?.actor && event?.writerId);
  assert.ok(receipt?.stepBaseHead && receipt?.dispatchId);
});

// Why: These static log checks identify the stated invariant, not a fresh TLC check or a necessary outcome fence.
test('each recorded single-guard control failed its named invariant', () => {
  const safe = text('WorkflowRunner.cfg');
  for (const [name, [guard, invariant]] of Object.entries(guards)) {
    const config = text(`${name}.cfg`);
    assert.match(config, new RegExp(`^  ${guard} = FALSE$`, 'm'));
    assert.match(config, /^  WriterFenceGuard = TRUE$/m);
    assert.match(config, /^  TransferEpochGuard = TRUE$/m);
    for (const other of new Set(Object.values(guards).map(([constant]) => constant))) {
      if (other !== guard) assert.match(config, new RegExp(`^  ${other} = TRUE$`, 'm'));
      assert.match(safe, new RegExp(`^  ${other} = TRUE$`, 'm'));
    }
    assert.match(text(`tlc-fix5-${name}.out`), new RegExp(`Error: Invariant ${invariant} is violated\\.`));
  }
});

// Why: The writer check and transfer epoch bump are redundant separately but unsafe when removed together.
test('recorded paired writer/transfer control fails the old-writer outcome', () => {
  const config = text('unsafe-writer-transfer.cfg');
  assert.match(config, /^  WriterFenceGuard = FALSE$/m);
  assert.match(config, /^  TransferEpochGuard = FALSE$/m);
  assert.match(text('tlc-fix5-unsafe-writer-transfer.out'), /Error: Invariant NoOldWriterAdvance is violated\./);
});

// Why: This audits pinned bytes and committed logs only; a fresh TLC run is required to catch removed guards.
test('recorded safety and liveness outputs name the pinned model bytes', async () => {
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(text('WorkflowRunner.tla')).digest('hex');
  assert.ok(text('tlc-output.md').includes(digest));
  for (const name of ['WorkflowRunner', 'live']) {
    assert.match(text(`tlc-fix5-${name}.out`), /Model checking completed\. No error has been found\./);
    assert.match(text(`tlc-fix5-${name}.out`), /0 states left on queue\./);
  }
});

// Why: This audits the committed probe outputs; it does not execute the model or independently prove liveness.
test('ported Opus re-review probe logs retain their recorded outcomes', (t) => {
  if (!existsSync(new URL('tlc-fix5-probe-re2-no-dispatch.out', root))) {
    t.skip('probe-re2 review-port logs are not in the public tree');
    return;
  }
  for (const name of ['no-dispatch', 'epoch', 'writer', 'trust', 'L3', 'L4', 'L5', 'L6']) {
    const output = text(`tlc-fix5-probe-re2-${name}.out`);
    assert.match(output, /Model checking completed\. No error has been found\./, name);
    assert.match(output, /0 states left on queue\./, name);
  }
  assert.match(text('tlc-fix5-probe-re2-cancel-nonabsorb.out'),
    /Error: Invariant NoCancelTerminal is violated\./);
});
