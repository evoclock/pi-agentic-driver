import { createHash } from 'node:crypto';
import { validateRecord } from './records.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const stateId = value => `state-${hash(value)}`;
const actionId = value => `action-${hash(value)}`;
const issue = (code, message) => ({ id: `t07-${code}`, code, message, origin: 'model-run', evidenceIds: [] });

// This accepts TLC's numbered counterexample states, not its unrestricted model language.
export function parseTlcTrace(output) {
  if (typeof output !== 'string') throw new TypeError('TLC output must be text');
  const states = [];
  let current;
  let loop = null;
  for (const line of output.split(/\r?\n/)) {
    const start = /^State (\d+):\s*(.*)$/.exec(line);
    const back = /^Back to state (\d+):?\s*$/.exec(line);
    if (start) {
      if (current) states.push(current);
      current = { number: Number(start[1]), label: start[2], lines: [] };
    } else if (back) {
      if (current) states.push(current);
      current = undefined;
      loop = Number(back[1]);
      break;
    } else if (current) {
      if (!line.trim()) {
        states.push(current);
        current = undefined;
      } else current.lines.push(line);
    }
  }
  if (current) states.push(current);
  if (!states.length || states.some((s, i) => s.number !== i + 1 || !s.lines.length) || (loop !== null && (loop < 1 || loop > states.length))) return null;
  return { states, loop };
}

// Graph input is an explicit, complete supported-graph.v1 export. TLC stdout alone is never a full graph.
export function normalizeCheckerView({ bundleDigest, mode = 'protocol', actions = [], graph = null, output = '', limits = {}, ruleIds = [] }) {
  if (!/^[a-f0-9]{64}$/.test(bundleDigest) || !['protocol', 'light'].includes(mode) || !Array.isArray(actions) || actions.some(a => typeof a !== 'object' || typeof a.name !== 'string' || !a.name)) throw new TypeError('Invalid view input');
  const findings = [];
  const inventory = actions.map(a => ({ ...a, actionId: a.actionId ?? actionId([a.name, a.modelLocation ?? '']), hierarchyPath: a.hierarchyPath ?? [], regionPath: a.regionPath ?? [] }));
  if (new Set(inventory.map(a => a.actionId)).size !== inventory.length) throw new TypeError('Duplicate action ID');
  const trace = parseTlcTrace(output);
  let states = [];
  let transitions = [];
  let provenance = 'declared-actions';
  let traceSteps = [];
  if (graph?.schema === 'model-fidelity.supported-graph.v1' && Array.isArray(graph.states) && graph.states.length && Array.isArray(graph.transitions) && graph.complete === true) {
    const ids = new Map();
    for (const s of graph.states) {
      if (typeof s.id !== 'string' || !s.id || ids.has(s.id) || s.values === undefined) throw new TypeError('Invalid graph state');
      const id = stateId(s.values);
      ids.set(s.id, id);
      const underlyingIds = s.underlyingIds ?? [s.id];
      if (!Array.isArray(underlyingIds) || !underlyingIds.length || underlyingIds.some(x => typeof x !== 'string') || !Array.isArray(s.ruleIds ?? []) || !Array.isArray(s.mayBreakRuleIds ?? [])) throw new TypeError('Invalid grouped graph state');
      states.push({ id, label: s.label ?? s.id, values: s.values, hierarchyPath: s.hierarchyPath ?? [], regionPath: s.regionPath ?? [], ruleIds: s.ruleIds ?? [], mayBreakRuleIds: s.mayBreakRuleIds ?? [], marks: [...(s.ruleIds?.length ? ['breaks'] : []), ...(s.mayBreakRuleIds?.length ? ['mayBreak'] : [])], underlyingIds });
    }
    if (new Set(ids.values()).size !== ids.size) throw new TypeError('Duplicate graph state values');
    if (new Set(states.flatMap(s => s.underlyingIds)).size !== states.reduce((n, s) => n + s.underlyingIds.length, 0)) throw new TypeError('Overlapping grouped state IDs');
    transitions = graph.transitions.map(t => {
      if (!ids.has(t.from) || !ids.has(t.to) || typeof t.actionId !== 'string') throw new TypeError('Invalid graph transition');
      return { from: ids.get(t.from), to: ids.get(t.to), actionId: t.actionId, condition: t.condition ?? '', hidden: Boolean(t.hidden) };
    });
    provenance = 'supported-graph';
    if (trace) {
      traceSteps = trace.states.map((s, index) => ({ ordinal: s.number, stateId: ids.get(graph.traceStateIds?.[index]), rawLabel: s.label, rawValues: s.lines.join('\n'), provenance: 'tlc-counterexample' }));
      if (traceSteps.some(s => !s.stateId) || (trace.loop !== null && !ids.has(graph.traceStateIds?.[trace.loop - 1]))) findings.push(issue('trace-unmapped', 'Counterexample states do not all map to the supplied graph.'));
      else {
        const path = traceSteps.map(s => s.stateId);
        for (const t of transitions) {
          if (t.hidden && path.some((id, i) => id === t.from && path[i + 1] === t.to)) {
            t.hidden = false;
            findings.push(issue('failure-step-visible', 'A hidden step on the counterexample path was made visible.'));
          }
        }
        for (const s of traceSteps) {
          const node = states.find(n => n.id === s.stateId);
          node.marks = [...new Set([...node.marks, 'bugPath', ...(s.ordinal === traceSteps.length && ruleIds.length ? ['breaks'] : [])])];
          if (s.ordinal === traceSteps.length) node.ruleIds = [...new Set([...node.ruleIds, ...ruleIds])];
        }
        if (trace.loop !== null) {
          const from = traceSteps.at(-1).stateId;
          const to = traceSteps[trace.loop - 1].stateId;
          transitions.push({ from, to, actionId: 'tlc-loop', repeats: true, provenance: 'tlc-counterexample' });
          states.find(s => s.id === to).marks.push('repeats');
        }
      }
    }
  } else {
    findings.push(issue('unexplored', 'No complete supported graph was provided. Declared actions are not an explored state space.'));
    if (graph) findings.push(issue('unsupported-graph', 'Unsupported or incomplete graph format; no completeness claim is possible.'));
    if (trace) findings.push(issue('trace-without-graph', 'TLC trace is retained, but its states cannot establish a complete graph.'));
    states = [{ id: 'unexplored', label: 'UNEXPLORED declared actions', hierarchyPath: [], regionPath: [], marks: ['UNEXPLORED'], underlyingIds: [] }, ...inventory.map(a => ({ id: `declared-${a.actionId}`, label: a.name, actionId: a.actionId, hierarchyPath: a.hierarchyPath, regionPath: a.regionPath, marks: ['UNEXPLORED'], underlyingIds: [] }))];
    transitions = inventory.map(a => ({ from: 'unexplored', to: `declared-${a.actionId}`, actionId: a.actionId, condition: 'declared, not explored' }));
    traceSteps = trace?.states.map(s => ({ ordinal: s.number, rawLabel: s.label, rawValues: s.lines.join('\n'), provenance: 'tlc-counterexample' })) ?? [];
  }
  const view = { schema: 'model-fidelity.view.v1', bundleDigest, viewId: 'lifecycle', mode, states, transitions, findings: findings.map(f => f.id), hiddenSteps: transitions.filter(t => t.hidden).map(t => `${t.from} -> ${t.to} (${t.actionId})`), grouping: { provenance, traceSteps, loopBackTo: trace?.loop ?? null, actions: inventory, bounds: limits, uncheckedRuleIds: ruleIds.filter(id => !states.some(s => s.ruleIds?.includes(id))) } };
  if (mode === 'light') view.omittedViews = [{ viewId: 'action-map', status: 'not-applicable', reason: 'Light mode does not assess implementation actions.' }, { viewId: 'fault-window', status: 'not-applicable', reason: 'Light mode does not assess protocol fault windows.' }];
  const valid = validateRecord('view', view);
  if (!valid.ok) throw new TypeError(valid.errors.join('; '));
  return { view, findings };
}
