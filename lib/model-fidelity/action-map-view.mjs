// A declared inventory is not an explored state graph. Keep map claims distinct from evidence.
export function actionMapView(view, { actionMaps = [] } = {}) {
  if (view.mode === 'light') throw new TypeError('Action map is not applicable in light mode');
  if (view.states.length) return view;
  const states = actionMaps.length ? actionMaps.map(map => ({
    id: map.actionId, actionId: map.actionId, label: map.actionId,
    regionPath: [map.actor ?? 'actor unknown', map.session ?? 'session unknown'],
    details: [
      'UNEXPLORED: declared action, not a checked graph',
      `Operation: ${map.realOperation ?? 'unknown'}; Kind: ${map.kind ?? 'unknown'}; Model: ${map.modelLocation ?? 'unknown'}`,
      `Actor: ${map.actor ?? 'unknown'}; Session: ${map.session ?? 'unknown'}`,
      `Privilege: ${map.privilege ?? 'unknown'}; Preconditions: ${(map.preconditions ?? []).join(', ') || 'unknown'}`,
      `Observed: ${map.observedValue ?? 'unknown'} from ${map.observedFrom ?? 'unknown'}`,
      `Protected interval: ${map.protectedInterval ?? 'UNPROVEN STEP'}`,
      `Effect point: ${map.effectPoint ?? 'unknown'}`,
      `Evidence: ${(map.sourceEvidenceIds ?? []).join(', ') || 'none'}`,
      `ASSUMED: ${(map.assumptions ?? []).join(', ') || 'none stated'}`,
    ].join('\n'),
  })) : [{ id: 'unexplored', label: 'UNEXPLORED action map', details: 'No declared actions or graph supplied. Coverage is unknown.' }];
  return { ...view, states, transitions: [], declaredActionMaps: actionMaps, exploration: 'unexplored' };
}
