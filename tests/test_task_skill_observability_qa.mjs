// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
// Static preparation only: execute solely through the approved contained runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import observe from '../extensions/task-skill-observability.ts';
import * as observer from '../scripts/enforcement/task_skill_observability_pi.js';
const { aggregateSkillObservations, normalizeSkillObservation, observationId, summarizeSkillObservations } = observer;

const identity = { sessionId: 'session-a', taskId: 'task-a', workerId: 'session', attemptId: 'attempt-a' };
const recipe = { ...identity, kind: 'recipe', eventId: 'recipe-a', recipe: 'feature', source: 'pi-poteto-mode',
  version: '0.15.36', requiredSkills: ['how-pi'], requiredSteps: ['1'] };
const outcome = { ...identity, kind: 'outcome', eventId: 'outcome-a', outcome: 'success', reason: 'verified-result' };

// The existing harness is private to a frozen test file; this small hook fixture avoids editing that file.
function hooks() {
  const journal = [], handlers = new Map(), tools = new Map();
  observe({ on: (name, handler) => handlers.set(name, handler), registerTool: (tool) => tools.set(tool.name, tool),
    appendEntry: (customType, data) => journal.push({ type: 'custom', customType, data }) });
  const ctx = { cwd: '/opt/observer-fixture', sessionManager: { getSessionId: () => 'session-a', getBranch: () => journal } };
  return { journal, emit: (name, event) => { assert.ok(handlers.has(name), `Expected ${name} observer hook`); handlers.get(name)(event, ctx); },
    report: () => tools.get('agentic_task_skill_observation').execute('report-a', { kind: 'report' }, null, null, ctx) };
}

// Why: an anonymous partition must not be reported as an identified fleet worker or role.
test('QA anonymous worker partition is explicitly uncaptured, caller IDs remain unverified', () => {
  const report = summarizeSkillObservations([recipe]);
  assert.equal(report.attempts[0].workerId, null);
  assert.equal(report.attempts[0].workerIdentityProvenance, 'not-captured');
  assert.ok(report.captureLimits.includes('role-without-matched-spawn-not-captured'));
  const declared = summarizeSkillObservations([{ ...recipe, workerId: 'declared-worker' }]).attempts[0];
  assert.equal(declared.workerId, observationId('declared-worker'));
  assert.equal(declared.workerIdentityProvenance, 'caller-declared');
});

// Why: partial capture cannot silently appear complete in an empty or filtered report.
test('QA empty and task reports disclose unsupported axes', () => {
  for (const report of [summarizeSkillObservations([]), summarizeSkillObservations([recipe], { taskId: 'task-a' })]) {
    for (const limit of ['skill-command-expansion-and-use-not-verified', 'role-without-matched-spawn-not-captured',
      'cross-session-input-may-be-incomplete', 'availability-inventory-not-captured',
      'playbook-and-reference-reads-not-captured', 'other-skill-roots-not-captured', 'pre-observer-history-not-captured']) {
      assert.ok(report.captureLimits.includes(limit), limit);
    }
    assert.equal(report.totals.compliant, 0);
  }
});

// Why: conflicting manifests cannot silently select the first declaration's denominator.
test('QA conflicting recipes have no selected manifest or verified coverage', () => {
  const report = summarizeSkillObservations([recipe, { ...recipe, eventId: 'recipe-b', version: '0.15.37' }]);
  const row = report.attempts[0];
  assert.equal(row.recipe, null);
  assert.equal(row.requirementsProvenance, 'conflicting-caller-declarations');
  assert.equal(row.coverage, 'requirements-conflicting');
  assert.equal(row.compliant, false);
  assert.equal(report.totals.requirementsConflicting, 1);
});

// Why: repeating the same requirements in a different set order is not a contradictory recipe.
test('QA equivalent repeated declarations retain caller-only provenance', () => {
  const first = { ...recipe, requiredSteps: ['1', '2'], requiredSkills: ['how-pi', 'why-pi'] };
  const second = { ...first, eventId: 'recipe-b', requiredSteps: ['2', '1'], requiredSkills: ['why-pi', 'how-pi'] };
  const row = summarizeSkillObservations([first, second]).attempts[0];
  assert.equal(row.requirementsProvenance, 'caller-declared');
  assert.equal(row.recipe.name, 'feature');
  assert.equal(row.compliant, false);
});

// Why: corrected legacy reason projection needs an assertion for both new and persisted observations.
test('SPA legacy success is caller-reported without rewriting stored entries', () => {
  const fresh = summarizeSkillObservations([recipe, outcome]).attempts[0];
  assert.equal(fresh.reportedReason, 'caller-reported-result');
  const stored = [recipe, outcome].map((entry) => normalizeSkillObservation(entry));
  stored[1].reason = 'verified-result';
  const before = JSON.stringify(stored);
  const persisted = summarizeSkillObservations(stored, { persisted: true }).attempts[0];
  assert.equal(persisted.reportedReason, 'caller-reported-result');
  assert.equal(persisted.outcome, 'unknown');
  assert.equal(persisted.compliant, false);
  assert.equal(JSON.stringify(stored), before);
});

// Why: successful work, available reads and reported success cannot independently verify skill execution.
test('SPA successful citation preserves unmeasured availability and unknown success', () => {
  const ref = 'work-a';
  const events = [recipe, { ...identity, kind: 'read', eventId: 'read-a', skill: 'how-pi', ref: 'read-call' },
    { ...identity, kind: 'tool', eventId: 'tool-a', ref, result: 'ok', toolClass: 'work' },
    { ...identity, kind: 'activity', eventId: 'step-a', ref, skill: 'how-pi', activity: 'step', stepId: '1' },
    { ...outcome, ref }];
  for (const options of [{}, { taskId: 'task-a' }]) {
    const row = summarizeSkillObservations(events, options).attempts[0];
    assert.equal(row.available, 'not-captured');
    assert.equal(row.loadEvents, 1);
    assert.equal(row.requiredSteps[0].status, 'cited-activity');
    assert.equal(row.reportedReason, 'caller-reported-result');
    assert.equal(row.outcome, 'unknown');
    assert.equal(row.compliant, false);
  }
});

// Why: optional links describe assertions, never authenticated presence or absence.
test('SPA absent, single and conflicting links retain explicit provenance', () => {
  const empty = summarizeSkillObservations([recipe]).attempts[0];
  assert.equal(empty.parentTaskLinkProvenance, 'not-asserted');
  assert.equal(empty.dispatchLinkProvenance, 'not-asserted');
  const one = { ...recipe, parentTaskId: 'parent-a', dispatchId: 'dispatch-a' };
  const single = summarizeSkillObservations([one]).attempts[0];
  assert.equal(single.parentTaskLinkProvenance, 'caller-declared');
  assert.equal(single.dispatchLinkProvenance, 'caller-declared');
  const conflict = summarizeSkillObservations([one, { ...one, eventId: 'recipe-b', parentTaskId: 'parent-b', dispatchId: 'dispatch-b' }]).attempts[0];
  assert.equal(conflict.parentTaskId, null);
  assert.equal(conflict.dispatchId, null);
  assert.equal(conflict.parentTaskLinkProvenance, 'conflicting-caller-declarations');
  assert.equal(conflict.dispatchLinkProvenance, 'conflicting-caller-declarations');
});

// Why: a configurable neutral root must count leaf reads without retaining their filesystem paths.
test('QA configured root counts reads without operator-specific source paths', async () => {
  const previous = process.env.PI_POTETO_SKILLS_ROOT;
  process.env.PI_POTETO_SKILLS_ROOT = '/opt/observer-fixture/skills';
  try {
    const run = hooks(); run.emit('session_start', { reason: 'new' });
    run.emit('tool_result', { toolName: 'TaskCreate', toolCallId: 'create-a', details: { task: { id: 'task-a' } } });
    run.emit('tool_result', { toolName: 'TaskUpdate', toolCallId: 'start-a', input: { taskId: 'task-a', status: 'in_progress' },
      details: { success: true, taskId: 'task-a', statusChange: { from: 'pending', to: 'in_progress' } } });
    run.emit('tool_call', { toolName: 'read', toolCallId: 'read-a' });
    run.emit('tool_result', { toolName: 'read', toolCallId: 'read-a', input: { path: '/opt/observer-fixture/skills/how-pi/SKILL.md' } });
    run.emit('tool_call', { toolName: 'read', toolCallId: 'outside-a' });
    run.emit('tool_result', { toolName: 'read', toolCallId: 'outside-a', input: { path: '/opt/another-root/how-pi/SKILL.md' } });
    const report = (await run.report()).details;
    assert.equal(report.totals.loadEvents, 1);
    assert.equal(report.attempts[0].workerId, null);
    assert.doesNotMatch(JSON.stringify(run.journal), /observer-fixture|another-root/);
  } finally {
    if (previous === undefined) delete process.env.PI_POTETO_SKILLS_ROOT;
    else process.env.PI_POTETO_SKILLS_ROOT = previous;
  }
});

// Why: a matched coordinator spawn identifies a role only for a separately observed worker pane.
test('QA aggregate joins observed pane to a validated spawn without trusting declarations', () => {
  assert.equal(typeof aggregateSkillObservations, 'function');
  const pane = observationId('w11:p2T');
  const worker = { ...recipe, eventId: 'worker-recipe', workerId: pane, paneId: pane, kind: 'task', phase: 'started' };
  const spawn = { ...recipe, kind: 'spawn', eventId: 'spawn-a', sessionId: 'coordinator', role: 'implementation', paneId: pane };
  const recipeRow = { ...recipe, eventId: 'worker-manifest', workerId: pane };
  const joined = aggregateSkillObservations([worker, recipeRow, spawn, spawn]);
  assert.equal(joined.roles.implementation, 1);
  assert.equal(joined.attempts, 1);
  assert.equal(aggregateSkillObservations([worker, recipeRow]).roles['not-captured'], 1);
  const unobserved = aggregateSkillObservations([{ ...recipeRow, workerId: 'claimed-worker' }, spawn]);
  assert.equal(unobserved.roles['not-captured'], 1);
  assert.equal(normalizeSkillObservation({ ...spawn, role: 'coordinator' }), null);
  assert.equal(normalizeSkillObservation({ ...spawn, role: 'bad role' }), null);
});

// Why: only the three named Herdr pane variables create an observed worker partition, not a role.
test('QA named pane environment yields hashed worker without attributing role', () => {
  const names = ['HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID'];
  const old = names.map((name) => process.env[name]);
  [process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID] = ['w11', 'w11:t2T', 'w11:p2T'];
  try {
    const run = hooks(); run.emit('session_start', { reason: 'new' });
    run.emit('tool_result', { toolName: 'TaskCreate', toolCallId: 'create-a', details: { task: { id: 'task-a' } } });
    const row = summarizeSkillObservations(run.journal.map((entry) => entry.data), { persisted: true }).attempts[0];
    assert.equal(row.workerId, observationId('w11:p2T'));
    assert.equal(row.workerIdentityProvenance, 'herdr-pane-observed');
    assert.equal(row.role, null);
    assert.doesNotMatch(JSON.stringify(run.journal), /w11:p2T/);
  } finally {
    names.forEach((name, index) => old[index] === undefined ? delete process.env[name] : process.env[name] = old[index]);
  }
});

// Why: only a successful coordinator tool result records a validated returned role and pane.
test('QA coordinator spawn hook records a role only from a successful result', () => {
  const run = hooks(); run.emit('session_start', { reason: 'new' });
  run.emit('tool_result', { toolName: 'agentic_herdr_spawn_worker', toolCallId: 'spawn-a', isError: false,
    details: { ok: true, status: 'spawned', paneId: 'w11:p2T', role: 'implementation' } });
  run.emit('tool_result', { toolName: 'agentic_herdr_spawn_worker', toolCallId: 'spawn-b', isError: false,
    details: { ok: true, status: 'partial', paneId: 'w11:p3T', role: 'review' } });
  run.emit('tool_result', { toolName: 'agentic_herdr_spawn_worker', toolCallId: 'spawn-c', isError: false,
    details: { ok: true, status: 'spawned', paneId: 'w11:p4T', role: 'coordinator-helper' } });
  const rows = run.journal.map((entry) => entry.data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'implementation');
  assert.equal(rows[0].paneId, observationId('w11:p2T'));
  assert.doesNotMatch(JSON.stringify(rows), /w11:p2T|w11:p3T|w11:p4T/);
});

// Why: submissions count once without retaining command arguments or asserting skill execution.
test('QA input command records only allowlisted skill and aggregate deduplicates replay', () => {
  assert.equal(typeof aggregateSkillObservations, 'function');
  const run = hooks(); run.emit('session_start', { reason: 'new' });
  run.emit('tool_result', { toolName: 'TaskCreate', toolCallId: 'create-a', details: { task: { id: 'task-a' } } });
  run.emit('tool_result', { toolName: 'TaskUpdate', toolCallId: 'start-a', input: { taskId: 'task-a', status: 'in_progress' },
    details: { success: true, taskId: 'task-a', statusChange: { from: 'pending', to: 'in_progress' } } });
  run.emit('input', { text: '/skill:how-pi secret args never logged' });
  run.emit('input', { text: '/skill:untrusted-pi secret args' });
  const data = run.journal.map((entry) => entry.data);
  const report = summarizeSkillObservations(data, { persisted: true });
  assert.equal(report.attempts[0].commandSubmissions, 1);
  assert.equal(report.attempts[0].citedSkills.length, 0);
  assert.equal(aggregateSkillObservations([...data, ...data]).skills.commandSubmissions['how-pi'], 1);
  assert.doesNotMatch(JSON.stringify(data), /secret args|untrusted-pi/);
});

// Why: public sync publishes docs/tests too, and escaped home separators must not evade privacy checks.
test('QA all observer source, docs and fixtures reject personal names and escaped home paths', () => {
  // Reuse the public skill-text check's operator-name oracle, extending its file coverage.
  const personalName = new RegExp(`${['ju', 'len'].join('')}|${['gam', 'boa'].join('')}`, 'i');
  const attribution = /^\s*(?:#|\/\/|<!--)?\s*SPDX-/;
  const homePath = new RegExp('/(?:' + ['Us', 'ers'].join('') + '|' + ['ho', 'me'].join('') + ')/', 'i');
  const neutralHomeFixture = '/' + ['Us', 'ers'].join('') + '/fixture/leaf';
  for (const value of [neutralHomeFixture, neutralHomeFixture.replaceAll('/', '\\/'), neutralHomeFixture.replaceAll('/', '\\\\/')]) {
    assert.match(value.replace(/\\+\//g, '/'), homePath);
  }
  const files = ['extensions/task-skill-observability.ts', 'scripts/enforcement/task_skill_observability_pi.js',
    'docs/task-skill-observability.md', 'tests/test_task_skill_observability.mjs', 'tests/test_task_skill_observability_qa.mjs',
    'tests/fixtures/observability-sdk.mjs', 'tests/fixtures/observability-public-dry-run.py',
    'scripts/task_skill_observation_report.mjs'];
  for (const file of files) {
    const lines = readFileSync(new URL('../' + file, import.meta.url), 'utf8').split('\n');
    const text = lines.join('\n').replace(/\\+\//g, '/');
    assert.doesNotMatch(text, homePath, file);
    for (const line of lines) if (!line.match(attribution)) assert.doesNotMatch(line, personalName, file);
  }
});
