import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCheckerView, parseTlcTrace } from '../lib/model-fidelity/traces.mjs';

const bundleDigest = 'a'.repeat(64);
const actions = [{ name: 'Clear', modelLocation: 'Case.tla:12', regionPath: ['Sender'] }, { name: 'Effect', modelLocation: 'Case.tla:20', hierarchyPath: ['In flight'] }];
const output = `Error: Temporal property Safe is violated.\nThe behavior up to this point is:\nState 1: <Initial>\n/\\ phase = "idle"\n\nState 2: <Clear>\n/\\ phase = "sent"\n\nState 3: <Effect>\n/\\ phase = "bad"\n\nBack to state 2:`;
const graph = { schema: 'model-fidelity.supported-graph.v1', complete: true, states: [
  { id: 'a', values: { phase: 'idle' }, label: 'Idle' }, { id: 'b', values: { phase: 'sent' }, label: 'Sent' }, { id: 'c', values: { phase: 'bad' }, label: 'Bad', ruleIds: ['Safe'] },
], transitions: [{ from: 'a', to: 'b', actionId: 'clear' }, { from: 'b', to: 'c', actionId: 'effect', hidden: true }, { from: 'c', to: 'a', actionId: 'reset', hidden: true }], traceStateIds: ['a', 'b', 'c'] };

// Why: losing a raw step or loop destination makes the displayed failure path misleading.
test('TLC counterexample preserves order, values and loop destination', () => {
  assert.deepEqual(parseTlcTrace(output)?.states.map(s => [s.number, s.label, s.lines[0]]), [[1, '<Initial>', '/\\ phase = "idle"'], [2, '<Clear>', '/\\ phase = "sent"'], [3, '<Effect>', '/\\ phase = "bad"']]);
  assert.equal(parseTlcTrace(output)?.loop, 2);
  assert.equal(parseTlcTrace('State 2: <bad>\n/\\ x = 1'), null);
});

// Why: reorderings and hidden edges cannot change a reader's failure evidence.
test('supported graph binds trace order to stable state IDs without dropping repeats or hidden steps', () => {
  const first = normalizeCheckerView({ bundleDigest, actions, graph, output, ruleIds: ['Safe'], limits: { maxStates: 10 } });
  const second = normalizeCheckerView({ bundleDigest, actions, graph: { ...graph, states: [...graph.states].reverse() }, output, ruleIds: ['Safe'] });
  assert.deepEqual(first.view.states.map(s => s.id).sort(), second.view.states.map(s => s.id).sort());
  assert.deepEqual(first.view.grouping.traceSteps.map(s => s.stateId), graph.traceStateIds.map(id => first.view.states.find(s => s.underlyingIds.includes(id)).id));
  assert.equal(first.view.transitions.at(-1).repeats, true);
  assert.equal(first.view.transitions.at(-1).to, first.view.grouping.traceSteps[1].stateId);
  assert.equal(first.view.transitions[1].hidden, false);
  assert.deepEqual(first.view.hiddenSteps, [`${first.view.transitions[2].from} -> ${first.view.transitions[2].to} (reset)`]);
  assert.ok(first.findings.some(f => f.code === 'failure-step-visible'));
  assert.ok(first.view.states.find(s => s.underlyingIds.includes('c')).marks.includes('breaks'));
  assert.equal(first.view.grouping.bounds.maxStates, 10);
});

// Why: absent full exploration must never appear as a safety pass.
test('missing, truncated, imported or unsupported graphs retain declared actions as unexplored', () => {
  for (const graphInput of [null, { ...graph, complete: false }, { schema: 'imported-tla', complete: true, states: graph.states, transitions: graph.transitions }]) {
    const result = normalizeCheckerView({ bundleDigest, actions, graph: graphInput, output });
    assert.equal(result.view.grouping.provenance, 'declared-actions');
    assert.equal(result.view.states.length, 3);
    assert.ok(result.view.states.every(s => s.marks.includes('UNEXPLORED')));
    assert.ok(result.findings.some(f => f.code === 'unexplored'));
    assert.equal(result.view.grouping.traceSteps.length, 3);
    assert.deepEqual(result.view.grouping.actions.map(a => a.name), ['Clear', 'Effect']);
  }
});

// Why: grouping must preserve the distinct rule IDs and disclose uncertain violations.
test('grouped state retains source IDs and may-break marks', () => {
  const grouped = { ...graph, states: [{ ...graph.states[0], underlyingIds: ['raw-a1', 'raw-a2'], mayBreakRuleIds: ['Timing'] }, ...graph.states.slice(1)] };
  const result = normalizeCheckerView({ bundleDigest, graph: grouped });
  assert.deepEqual(result.view.states[0].underlyingIds, ['raw-a1', 'raw-a2']);
  assert.deepEqual(result.view.states[0].mayBreakRuleIds, ['Timing']);
  assert.ok(result.view.states[0].marks.includes('mayBreak'));
});

// Why: a partial mode or ambiguous identity must be disclosed rather than guessed.
test('light view declares omissions and rejects ambiguous graph IDs', () => {
  assert.equal(normalizeCheckerView({ bundleDigest, mode: 'light', actions }).view.omittedViews.length, 2);
  assert.throws(() => normalizeCheckerView({ bundleDigest, graph: { ...graph, states: [graph.states[0], graph.states[0]] } }), /Invalid graph state/);
  assert.throws(() => normalizeCheckerView({ bundleDigest, graph: { ...graph, transitions: [{ from: 'a', to: 'missing', actionId: 'x' }] } }), /Invalid graph transition/);
});
