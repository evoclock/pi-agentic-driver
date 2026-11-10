// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeSkillObservation, observationId, summarizeSkillObservations } from '../scripts/enforcement/task_skill_observability_pi.js';
import observe from '../extensions/task-skill-observability.ts';

const base = { sessionId: 's1', taskId: '1', workerId: 'session', attemptId: 'a1' };
const task = { ...base, eventId: 'task1', kind: 'task', phase: 'started' };
const recipe = { ...base, eventId: 'r1', kind: 'recipe', recipe: 'feature', source: 'pi-poteto-mode', version: '0.15.36', requiredSkills: ['how-pi'], requiredSteps: ['1'] };
const tool = { ...base, eventId: 'tool1', kind: 'tool', ref: 'work1', result: 'ok', toolClass: 'work' };
const read = { ...base, eventId: 'read1', kind: 'read', skill: 'how-pi', ref: 'read-call' };
const step = { ...base, eventId: 'step1', kind: 'activity', activity: 'step', skill: 'how-pi', stepId: '1', ref: 'work1' };
const success = { ...base, eventId: 'end1', kind: 'outcome', outcome: 'success', reason: 'verified-result', ref: 'work1' };

// Why: Repeated file reads and a model's successful-work claim cannot certify recipe execution.
test('read counts and cited step coverage remain separate from verified outcome', () => {
  const report = summarizeSkillObservations([task, recipe, read, read, { ...read, eventId: 'read2' }, tool, step, success]);
  assert.equal(report.totals.loadEvents, 2);
  assert.equal(report.totals.distinctSkills, 1);
  assert.equal(report.attempts[0].requiredSteps[0].status, 'cited-activity');
  assert.equal(report.attempts[0].requirementsProvenance, 'caller-declared');
  assert.equal(report.attempts[0].reportedOutcome, 'success');
  assert.equal(report.attempts[0].outcome, 'unknown');
  assert.equal(report.totals.compliant, 0);
});

// Why: A missing or skipped required step cannot be counted as completed even when success is asserted.
test('missing and explicitly skipped steps stay incomplete', () => {
  const skip = { ...base, kind: 'activity', eventId: 'skip1', activity: 'skip', skill: 'how-pi', stepId: '1', reason: 'explicit-skip' };
  const missing = summarizeSkillObservations([task, recipe, read, success]);
  const skipped = summarizeSkillObservations([task, recipe, skip, success]);
  assert.equal(missing.totals.missingSteps, 1);
  assert.equal(skipped.attempts[0].requiredSteps[0].status, 'skipped');
  assert.equal(skipped.totals.skippedSteps, 1);
  assert.equal(skipped.totals.compliant, 0);
});

// Why: A cited failed tool supports a typed failure observation without inventing its cause.
test('failure after a successful read preserves read activity and cited tool error', () => {
  const error = { ...tool, result: 'error' };
  const failure = { ...success, outcome: 'failure', reason: 'tool-error' };
  const result = summarizeSkillObservations([recipe, read, error, failure]);
  assert.equal(result.attempts[0].loadEvents, 1);
  assert.equal(result.attempts[0].outcome, 'failure');
  assert.equal(result.attempts[0].reason, 'tool-error');
});

// Why: Different attempts and interleaved reports must not cross-claim the same evidence.
test('out-of-order retries, replay and missing capture remain distinct', () => {
  const retry = [task, recipe, tool, step, success].map((e) => ({ ...e, attemptId: 'a2', eventId: `${e.eventId}-retry` }));
  const report = summarizeSkillObservations([success, ...retry, read, task, recipe, tool, step, success]);
  assert.equal(report.totals.attempts, 2);
  assert.equal(report.totals.compliant, 0);
  const empty = summarizeSkillObservations([{ ...task, eventId: 'task2' }]);
  assert.equal(empty.attempts[0].coverage, 'requirements-unknown');
  assert.equal(empty.attempts[0].outcome, 'unknown');
});

// Why: Only closed recipe fields and opaque hashes enter telemetry, not secrets, paths or arbitrary labels.
test('normalization rejects free text and hashes caller identifiers', () => {
  const privateValue = 'sk-example-secret';
  const entry = normalizeSkillObservation({ ...recipe, taskId: privateValue, prompt: 'raw private prompt', path: '/private/key', token: privateValue });
  assert.ok(entry);
  assert.equal(entry.taskId, observationId(privateValue));
  const hexSecret = 'a'.repeat(64);
  assert.equal(normalizeSkillObservation({ ...recipe, taskId: hexSecret }).taskId, observationId(hexSecret));
  assert.notEqual(observationId(hexSecret), hexSecret);
  assert.doesNotMatch(JSON.stringify(entry), /sk-example|raw private|private\/key/);
  assert.equal(normalizeSkillObservation({ ...recipe, requiredSteps: ['sk-example-secret'] }), null);
  assert.equal(normalizeSkillObservation({ ...recipe, version: privateValue }), null);
  assert.equal(normalizeSkillObservation({ ...recipe, recipe: privateValue }), null);
  assert.equal(normalizeSkillObservation({ ...recipe, requiredSkills: [privateValue] }), null);
});

function harness(journal = [], session = 's1') {
  const hooks = new Map(); const tools = new Map();
  const pi = { on(name, fn) { hooks.set(name, fn); }, registerTool(def) { tools.set(def.name, def); },
    appendEntry(type, data) { journal.push({ type: 'custom', customType: type, data }); } };
  const previous = process.env.PI_POTETO_SKILLS_ROOT;
  process.env.PI_POTETO_SKILLS_ROOT = '/scratch/observer-skills';
  try {
    observe(pi);
  } finally {
    if (previous === undefined) delete process.env.PI_POTETO_SKILLS_ROOT;
    else process.env.PI_POTETO_SKILLS_ROOT = previous;
  }
  const ctx = { sessionManager: { getSessionId: () => session, getBranch: () => journal } };
  const emit = (name, e) => hooks.get(name)(e, ctx);
  const declaration = (id, params) => tools.get('agentic_task_skill_observation').execute(id, params, null, null, ctx);
  return { journal, emit, declaration };
}

// Why: observability cannot certify itself through an author-modified shared verifier, including in public exports.
test('shared verifier matches the trusted pre-observer implementation', () => {
  const path = 'scripts/test_gate_runner.py';
  const digest = 'e741ef55f909c3af8eb135a40b6de1001af7ef369cb924b5fb6d4be6a2915d8a';
  const file = new URL(`../${path}`, import.meta.url);
  assert.ok(existsSync(file), `trusted verification file missing: ${path}`);
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), digest, path);
  const previous = process.env.PI_POTETO_SKILLS_ROOT;
  harness();
  assert.equal(process.env.PI_POTETO_SKILLS_ROOT, previous, 'fixture must restore caller environment');
});

// Why: Duplicate starts and observer calls must not create extra attempts or fabricate step evidence.
test('live hooks correlate task, reject observer/unrelated refs and retain one attempt', async () => {
  const run = harness(); run.emit('session_start', { reason: 'new' });
  run.emit('tool_result', { toolName: 'TaskCreate', toolCallId: 'create', details: { task: { id: '1' } }, isError: false });
  const update = { toolName: 'TaskUpdate', toolCallId: 'start', input: { taskId: '1', status: 'in_progress' },
    details: { success: true, taskId: '1', statusChange: { from: 'pending', to: 'in_progress' } }, isError: false };
  run.emit('tool_result', update); run.emit('tool_result', update);
  run.emit('tool_call', { toolName: 'read', toolCallId: 'read-call' });
  run.emit('tool_result', { toolName: 'read', toolCallId: 'read-call', input: { path: '/scratch/observer-skills/how-pi/SKILL.md' }, isError: false });
  const taskId = '1';
  const fake = await run.declaration('step-fake', { kind: 'activity', taskId, activity: 'step', skill: 'how-pi', stepId: '1', ref: 'read-call' });
  assert.equal(fake.details.ok, false);
  run.emit('tool_call', { toolName: 'agentic_task_skill_observation', toolCallId: 'observer-ref' });
  run.emit('tool_result', { toolName: 'agentic_task_skill_observation', toolCallId: 'observer-ref', isError: false });
  assert.equal((await run.declaration('step-self', { kind: 'activity', taskId, activity: 'step', skill: 'how-pi', stepId: '1', ref: 'observer-ref' })).details.ok, false);
  const report = (await run.declaration('report', { kind: 'report', taskId })).details;
  assert.equal(report.totals.attempts, 1);
  assert.equal(report.attempts[0].loadEvents, 1);
  assert.equal(report.totals.compliant, 0);
});

// Why: A successful terminal transition must detach the active attempt without claiming skill success.
test('completed and deleted task transitions stop attribution, including after resume', async () => {
  for (const terminal of ['completed', 'deleted']) {
    const journal = []; const run = harness(journal);
    run.emit('session_start', { reason: 'new' });
    run.emit('tool_result', { toolName: 'TaskCreate', toolCallId: 'create', details: { task: { id: '1' } }, isError: false });
    run.emit('tool_result', { toolName: 'TaskUpdate', toolCallId: 'start', input: { taskId: '1', status: 'in_progress' }, details: { success: true, taskId: '1', statusChange: { from: 'pending', to: 'in_progress' } }, isError: false });
    run.emit('tool_call', { toolName: 'bash', toolCallId: 'in-flight' });
    run.emit('tool_result', { toolName: 'TaskUpdate', toolCallId: 'unrelated', input: { taskId: '2', status: terminal }, details: { success: true, taskId: '2', statusChange: { from: 'in_progress', to: terminal } }, isError: false });
    run.emit('tool_result', { toolName: 'TaskUpdate', toolCallId: 'failed', input: { taskId: '1', status: terminal }, details: { success: false, taskId: '1' }, isError: false });
    run.emit('tool_result', { toolName: 'TaskUpdate', toolCallId: 'no-change', input: { taskId: '1', status: terminal }, details: { success: true, taskId: '1', updatedFields: [] }, isError: false });
    run.emit('tool_call', { toolName: 'bash', toolCallId: 'pre-terminal' });
    run.emit('tool_result', { toolName: 'bash', toolCallId: 'pre-terminal', isError: false });
    run.emit('tool_result', { toolName: 'TaskUpdate', toolCallId: 'end', input: { taskId: '1', status: terminal }, details: { success: true, taskId: '1', statusChange: { from: 'in_progress', to: terminal } }, isError: false });
    run.emit('tool_result', { toolName: 'bash', toolCallId: 'in-flight', isError: false });
    run.emit('tool_result', { toolName: 'TaskUpdate', toolCallId: 'start', input: { taskId: '1', status: 'in_progress' }, details: { success: true, taskId: '1', statusChange: { from: 'pending', to: 'in_progress' } }, isError: false });
    run.emit('tool_call', { toolName: 'bash', toolCallId: 'after-terminal' });
    run.emit('tool_result', { toolName: 'bash', toolCallId: 'after-terminal', isError: false });
    const resumed = harness(journal); resumed.emit('session_start', { reason: 'resume' });
    resumed.emit('tool_call', { toolName: 'bash', toolCallId: 'after-resume' });
    resumed.emit('tool_result', { toolName: 'bash', toolCallId: 'after-resume', isError: false });
    const refs = journal.filter((e) => e.data.kind === 'tool').map((e) => e.data.ref);
    assert.deepEqual(refs, [observationId('pre-terminal')], terminal);
    const report = (await resumed.declaration('report-terminal', { kind: 'report', taskId: '1' })).details;
    assert.equal(report.totals.attempts, 1);
    assert.equal(report.totals.captureGaps, 0);
    assert.equal(report.attempts[0].outcome, 'unknown');
    assert.equal(report.totals.compliant, 0);
  }
});

// Why: A real subsequent task or new in-progress transition may collect its own evidence, never the ended attempt's.
test('terminal task permits later task and genuine reopened attempt without cross-claiming work', () => {
  const run = harness(); run.emit('session_start', { reason: 'new' });
  run.emit('tool_result', { toolName: 'TaskCreate', toolCallId: 'create', details: { task: { id: '1' } }, isError: false });
  const update = (id, taskId, status, from) => run.emit('tool_result', { toolName: 'TaskUpdate', toolCallId: id,
    input: { taskId, status }, details: { success: true, taskId, statusChange: { from, to: status } }, isError: false });
  update('start', '1', 'in_progress', 'pending'); update('end', '1', 'completed', 'in_progress');
  run.emit('tool_result', { toolName: 'TaskCreate', toolCallId: 'create2', details: { task: { id: '2' } }, isError: false });
  update('start2', '2', 'in_progress', 'pending');
  run.emit('tool_call', { toolName: 'bash', toolCallId: 'second-work' });
  run.emit('tool_result', { toolName: 'bash', toolCallId: 'second-work', isError: false });
  update('reopen', '1', 'in_progress', 'completed');
  run.emit('tool_call', { toolName: 'bash', toolCallId: 'reopened-work' });
  run.emit('tool_result', { toolName: 'bash', toolCallId: 'reopened-work', isError: false });
  const report = summarizeSkillObservations(run.journal.map((e) => e.data), { persisted: true });
  const id1 = report.attempts.filter((a) => a.taskId === observationId('1'));
  const id2 = report.attempts.filter((a) => a.taskId === observationId('2'));
  assert.equal(id1.length, 2);
  assert.equal(id2.length, 1);
  assert.equal(id2[0].attemptId, observationId('create2'));
  assert.equal(report.totals.compliant, 0);
  assert.deepEqual(run.journal.filter((e) => e.data.kind === 'tool').map((e) => e.data.ref), [observationId('second-work'), observationId('reopened-work')]);
});

// Why: A resumed session needs the old attempt and an explicit capture gap, not a fresh phantom attempt.
test('session restart restores active attempt, gap and task-local refs', async () => {
  const journal = []; const first = harness(journal);
  first.emit('session_start', { reason: 'new' });
  first.emit('tool_result', { toolName: 'TaskCreate', toolCallId: 'create', details: { task: { id: '1' } }, isError: false });
  first.emit('tool_result', { toolName: 'TaskUpdate', toolCallId: 'start', input: { taskId: '1', status: 'in_progress' }, details: { success: true, taskId: '1', statusChange: { from: 'pending', to: 'in_progress' } } });
  const second = harness(journal); second.emit('session_start', { reason: 'resume' });
  second.emit('tool_call', { toolName: 'bash', toolCallId: 'work1' });
  second.emit('tool_result', { toolName: 'bash', toolCallId: 'work1', isError: false, input: { command: 'secret must not persist' }, content: [{ text: 'secret result' }] });
  const cited = await second.declaration('step1', { kind: 'activity', taskId: '1', activity: 'step', skill: 'how-pi', stepId: '1', ref: 'work1' });
  assert.equal(cited.details.ok, true);
  assert.doesNotMatch(JSON.stringify(journal), /secret/);
  const report = (await second.declaration('report1', { kind: 'report', taskId: '1' })).details;
  assert.equal(report.totals.attempts, 1);
  assert.equal(report.totals.captureGaps, 1);
  assert.equal(report.attempts[0].outcome, 'unknown');
});
