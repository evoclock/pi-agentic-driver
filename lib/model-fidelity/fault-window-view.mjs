// Preserve the sequence as supplied; a proposed schedule is never a TLC-observed trace.
export function faultWindowView(view, { schedules = [] } = {}) {
  if (view.mode === 'light') throw new TypeError('Fault windows are not applicable in light mode');
  if (view.states.length) return view;
  const states = [];
  const transitions = [];
  for (const schedule of schedules) {
    if (!['model-run', 'review-proposed'].includes(schedule.provenance)) throw new TypeError('Fault schedule requires explicit provenance');
    if (!Array.isArray(schedule.steps) || !schedule.steps.length) throw new TypeError('Fault schedule requires ordered steps');
    let previous;
    schedule.steps.forEach((step, index) => {
      const id = `${schedule.id}:${index}`;
      states.push({ id, actionId: step.actionId, label: step.label ?? step.actionId ?? step.stateId ?? id,
        regionPath: [step.actor ?? 'actor unknown', step.session ?? 'session unknown'],
        details: [`${schedule.provenance === 'model-run' ? 'TLC-observed' : 'Review-proposed'} path: ${schedule.id}`, `Step ${index + 1}: ${step.phase ?? 'unknown phase'}`, `Underlying state: ${step.stateId ?? 'not supplied'}`, `Action: ${step.actionId ?? 'not supplied'}`, `Evidence: ${(step.evidenceIds ?? []).join(', ') || 'none'}`, `Rules: ${(step.ruleIds ?? []).join(', ') || 'none stated'}`].join('\n') });
      if (previous) transitions.push({ from: previous, to: id, label: step.transition ?? step.phase ?? 'next', condition: step.condition });
      previous = id;
    });
  }
  if (!states.length) states.push({ id: 'unexplored', label: 'UNEXPLORED fault windows', details: 'No counterexample or proposed dangerous schedule supplied.' });
  return { ...view, states, transitions, schedules, exploration: schedules.length ? 'selected-paths' : 'unexplored' };
}
