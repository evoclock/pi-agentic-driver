import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishOutput } from './attempts.mjs';
import { validateRecord } from './records.mjs';
import { actionMapView } from './action-map-view.mjs';
import { faultWindowView } from './fault-window-view.mjs';

const renderer = fileURLToPath(import.meta.resolve('@evoclock/pi-bowerbird/bin/bowerbird.mjs'));
const scratch = path.resolve('.scratch');
const projections = { 'action-map': actionMapView, 'fault-window': faultWindowView };
const allowed = new Set(['lifecycle', 'results', ...Object.keys(projections)]);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const badge = f => `${f.mark ?? 'UNCHECKED'} [${f.id}] ${f.message ?? f.code ?? 'Gap'}${f.evidenceIds?.length ? ` Evidence: ${f.evidenceIds.join(', ')}` : ''}`;
const nodeId = (id, index) => `s${index}_${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

export function projectView(view, { findings = [], checks = [], controls = [], runtime = 'not-run', actionMaps = [], schedules = [] } = {}) {
  if (!allowed.has(view.viewId)) throw new TypeError('Unsupported view');
  const valid = validateRecord('view', view);
  if (!valid.ok) throw new TypeError(valid.errors.join('; '));
  if (projections[view.viewId]) view = projections[view.viewId](view, { actionMaps, schedules });
  const states = view.viewId === 'results'
    ? [
      { id: 'bounds', label: 'Checked bounds', details: checks.length ? checks.map(x => JSON.stringify(x)).join('\n') : 'UNCHECKED: no completed check' },
      { id: 'controls', label: 'Controls', details: controls.length ? controls.map(x => JSON.stringify(x)).join('\n') : 'UNCHECKED: no controls' },
      { id: 'runtime', label: 'Runtime', details: runtime === 'not-run' ? 'RUNTIME NOT RUN' : runtime },
      { id: 'gaps', label: 'Gaps', details: findings.length ? findings.map(badge).join('\n') : 'No reported findings; not a safety claim' },
    ] : view.states;
  const transitions = view.viewId === 'results'
    ? states.slice(1).map((s, i) => ({ from: states[i].id, to: s.id, label: 'next' }))
    : view.transitions;
  const allFindings = findings.filter(f => view.findings.includes(f.id));
  const nodes = states.map((s, i) => {
    const marks = allFindings.filter(f => f.stateId === s.id || f.actionId === s.actionId);
    const lines = [s.id, ...(s.regionPath?.length ? [`Region: ${s.regionPath.join(' / ')}`] : []), ...marks.map(f => `${f.mark ?? 'UNCHECKED'} [${f.id}]`)];
    return { id: nodeId(s.id, i), shape: view.viewId === 'lifecycle' && i === 0 ? 'initial' : s.id === 'red-line-hit' ? 'final' : 'state', at: [i % 4, Math.floor(i / 4)], title: s.label ?? s.id, lines, details: [s.details, `Underlying state: ${s.id}`, s.hierarchyPath?.length ? `Hierarchy: ${s.hierarchyPath.join(' / ')}` : '', ...marks.map(badge)].filter(Boolean).join('\n') };
  });
  const byId = new Map(states.map((s, i) => [s.id, nodes[i].id]));
  const edges = [];
  const occurrences = [];
  for (const t of transitions) {
    if (!byId.has(t.from) || !byId.has(t.to)) throw new TypeError(`Unknown transition endpoint: ${t.from} -> ${t.to}`);
    let to = byId.get(t.to);
    if (t.from === t.to) {
      const original = states.find(s => s.id === t.to);
      to = nodeId(t.to, nodes.length);
      nodes.push({ id: to, shape: 'state', at: [nodes.length % 4, Math.floor(nodes.length / 4)], title: `${original.label ?? t.to} (repeat)`, lines: [`Underlying state: ${t.to}`, 'REPEATS'], details: `Repeated occurrence of ${t.to}. Original self-loop retained in view.json.` });
      occurrences.push({ displayId: to, stateId: t.to, originalTransition: t });
    }
    edges.push({ from: byId.get(t.from), to, event: t.label ?? t.actionId ?? 'step', ...(t.condition ? { guard: t.condition } : {}) });
  }
  if (view.viewId === 'lifecycle') {
    if (!byId.has('red-line-hit')) nodes.push({ id: 'red-line-hit', shape: 'final', at: [nodes.length % 4, Math.floor(nodes.length / 4)], title: 'Red line hit', lines: ['Stop offending action only'], details: 'Raw-data overwrite or key-asset deletion. Unrelated work may continue.' });
    const red = byId.get('red-line-hit') ?? 'red-line-hit';
    for (const from of ['build', 'undo']) if (byId.has(from) && !edges.some(e => e.from === byId.get(from) && e.to === red)) edges.push({ from: byId.get(from), to: red, event: 'confirmed red line', kind: 'failure' });
  }
  const source = { schema: 'bowerbird/v1', meta: { title: `${view.viewId} | ${view.bundleDigest.slice(0, 12)}`, kind: 'statechart', grid: { col: 430, row: 220, gap: [190, 65] } }, nodes, edges };
  const text = [source.meta.title, ...states.map(s => `${s.id}: ${s.label ?? s.id} ${s.details ?? ''}`), ...transitions.map(t => `${t.from} -> ${t.to}: ${t.label ?? t.actionId ?? 'step'} ${t.condition ?? ''}`), ...allFindings.map(badge), ...(view.mode === 'light' ? view.omittedViews.map(v => `${v.viewId}: ${v.status} (${v.reason})`) : []), ...(view.hiddenSteps ?? []).map(s => `Hidden step: ${s}`), 'Flat fallback: hierarchy and parallel regions are named in text, not rendered as containers.'].join('\n');
  return { source, text, sidecar: { ...view, occurrences, sourceStateIds: states.map(s => s.id), findings: allFindings, checks, controls, runtime, layout: 'flat-fallback', originalTransitions: transitions } };
}

export async function renderView(claim, { view, resultId, findings = [], checks = [], controls = [], runtime = 'not-run', actionMaps = [], schedules = [], rendererPath = renderer }) {
  const projected = projectView(view, { findings, checks, controls, runtime, actionMaps, schedules });
  const ids = { viewId: view.viewId, resultId };
  const artifacts = [];
  const save = async (name, bytes) => artifacts.push(await publishOutput(claim, { kind: 'view', ids, name, bytes }));
  await save('view.json', `${JSON.stringify(projected.sidecar, null, 2)}\n`);
  await save('diagram.bower.json', `${JSON.stringify(projected.source, null, 2)}\n`);
  await save('diagram.txt', `${projected.text}\n`);
  let error;
  try {
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(path.join(scratch, 'mf-view-'));
    const input = path.join(dir, 'diagram.bower.json');
    await writeFile(input, `${JSON.stringify(projected.source)}\n`, { flag: 'wx' });
    for (const args of [['validate', input, '--strict'], ['render', input, '--view', 'flat', '--formats', 'html,svg', '--dark', 'dark', '--light', 'light', '--out', dir]]) {
      const run = spawnSync(process.execPath, [rendererPath, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
      if (run.error || run.status !== 0) throw new Error((run.stderr || run.stdout || run.error?.message || 'Renderer failed').slice(0, 1000));
    }
    for (const name of ['diagram.html', 'diagram.light.svg', 'diagram.dark.svg']) await save(name, await readFile(path.join(dir, name)));
  } catch (cause) {
    error = cause.message;
    await save('placeholder.html', `<!doctype html><meta charset="utf-8"><title>Diagram unavailable</title><p>Diagram unavailable. Read diagram.txt and diagram.bower.json.</p><p>${escape(error)}</p>\n`);
  }
  return { viewId: view.viewId, status: error ? 'unavailable' : 'rendered', artifactIds: artifacts.map(a => a.path), findings: error ? [{ id: `diagram-${resultId}`, code: 'diagram-unavailable', message: `Diagram unavailable: ${error}`, origin: 'host-observed-test', evidenceIds: artifacts.map(a => a.path), suggestedNext: 'Inspect source and renderer error; render again under a new result ID.' }] : [], unmetDiagram: Boolean(error) };
}
