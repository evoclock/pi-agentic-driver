// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
// Run only inside the approved no-network CI container. No credentials or live provider.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateSkillObservations, summarizeSkillObservations, observationId } from '../../scripts/enforcement/task_skill_observability_pi.js';
const modules = process.env.PI_OBSERVABILITY_SDK_MODULES;
assert.ok(modules, 'explicit isolated SDK modules required');
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } =
  await import(pathToFileURL(resolve(modules, '@earendil-works/pi-coding-agent/dist/index.js')).href);
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } =
  await import(pathToFileURL(resolve(modules, '@earendil-works/pi-ai/dist/index.js')).href);
const cwd = resolve(process.env.TMPDIR, 'observability-fresh-pi');
process.env.HERDR_WORKSPACE_ID = 'w11';
process.env.HERDR_TAB_ID = 'w11:t2T';
process.env.HERDR_PANE_ID = 'w11:p2T';
const skillRoot = process.env.PI_POTETO_SKILLS_ROOT;
assert.ok(skillRoot);
await mkdir(resolve(skillRoot, 'how-pi'), { recursive: true });
await writeFile(resolve(skillRoot, 'how-pi/SKILL.md'), '---\nname: how-pi\ndescription: Neutral offline fixture\n---\nRead the task.\n');
await mkdir(cwd, { recursive: true });
const faux = fauxProvider({ tokensPerSecond: 0 });
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider);
const loader = new DefaultResourceLoader({ cwd, agentDir: resolve(cwd, 'empty-profile'), additionalExtensionPaths:
  [resolve('extensions/tasks.ts'), resolve('extensions/task-skill-observability.ts')] });
await loader.reload();
const errors = loader.getExtensions?.().errors ?? [];
assert.deepEqual(errors, []);
const { session } = await createAgentSession({ cwd, model: faux.getModel(), modelRuntime: runtime,
  resourceLoader: loader, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(cwd) });
const call = (name, args, id) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: 'toolUse' });
const observation = (kind, args, id) => call('agentic_task_skill_observation', { kind, taskId: '1', ...args }, id);
faux.setResponses([
  call('TaskCreate', { subject: 'Offline observer BDD', description: 'Neutral scripted work', priority: 'P2' }, 'bdd-create'),
  call('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'bdd-start'),
  observation('recipe', { recipe: 'feature', source: 'pi-poteto-mode', version: '0.15.36', requiredSkills: ['how-pi'], requiredSteps: ['1', '2', '3'] }, 'bdd-recipe'),
  call('read', { path: resolve(skillRoot, 'how-pi/SKILL.md') }, 'bdd-read'),
  fauxAssistantMessage('Continue with the next submitted input.'),
  call('bash', { command: 'pwd' }, 'bdd-work'),
  observation('activity', { activity: 'step', skill: 'how-pi', stepId: '1', ref: 'bdd-work' }, 'bdd-step'),
  observation('activity', { activity: 'skip', skill: 'how-pi', stepId: '2', reason: 'explicit-skip' }, 'bdd-skip'),
  observation('outcome', { outcome: 'success', reason: 'verified-result', ref: 'bdd-work' }, 'bdd-outcome'),
  observation('report', {}, 'bdd-report'),
  call('TaskUpdate', { taskId: '1', status: 'completed' }, 'bdd-complete'),
  call('bash', { command: 'pwd' }, 'bdd-after-terminal'),
  call('TaskCreate', { subject: 'Offline observer failure', description: 'Neutral failure path', priority: 'P2' }, 'bdd2-create'),
  call('TaskUpdate', { taskId: '2', status: 'in_progress' }, 'bdd2-start'),
  observation('recipe', { taskId: '2', recipe: 'bug-fix', source: 'pi-poteto-mode', version: '0.15.36', requiredSkills: ['how-pi'], requiredSteps: ['1'] }, 'bdd2-recipe'),
  call('read', { path: resolve(skillRoot, 'how-pi/SKILL.md') }, 'bdd2-read'),
  call('bash', { command: 'exit 7' }, 'bdd2-failed-work'),
  observation('outcome', { taskId: '2', outcome: 'failure', reason: 'tool-error', ref: 'bdd2-failed-work' }, 'bdd2-outcome'),
  observation('report', { taskId: '2' }, 'bdd2-report'),
  fauxAssistantMessage('Offline fixture finished.'),
]);
try {
  await session.prompt('Run only the supplied offline fixture script.');
  await session.prompt('/skill:how-pi Continue the neutral task. Do not retain these arguments.');
  const toolResults = session.messages.filter((message) => message.role === 'toolResult');
  const expectedTools = ['TaskCreate', 'TaskUpdate', 'agentic_task_skill_observation', 'read', 'bash',
    'agentic_task_skill_observation', 'agentic_task_skill_observation', 'agentic_task_skill_observation',
    'agentic_task_skill_observation', 'TaskUpdate', 'bash',
    'TaskCreate', 'TaskUpdate', 'agentic_task_skill_observation', 'read', 'bash',
    'agentic_task_skill_observation', 'agentic_task_skill_observation'];
  console.log(JSON.stringify({ observedTools: toolResults.map((message) => ({ name: message.toolName, isError: !!message.isError })),
    expectedTools, providerCalls: faux.state.callCount }));
  assert.deepEqual(toolResults.map((message) => message.toolName), expectedTools);
  assert.deepEqual(toolResults.filter((message) => message.isError).map((message) => message.toolName), ['bash']);
  const entries = session.sessionManager.getEntries().filter((entry) => entry.type === 'custom'
    && entry.customType === 'agentic-driver.task-skill-observation.v1').map((entry) => entry.data);
  const report = summarizeSkillObservations(entries, { sessionId: observationId(session.sessionManager.getSessionId()), persisted: true });
  assert.equal(report.totals.attempts, 2);
  assert.equal(report.totals.loadEvents, 2);
  assert.equal(report.totals.skippedSteps, 1);
  assert.equal(report.totals.missingSteps, 2);
  const failed = report.attempts.find((attempt) => attempt.taskId === observationId('2'));
  assert.equal(failed.loadEvents, 1);
  assert.equal(failed.outcome, 'failure');
  assert.equal(failed.reason, 'tool-error');
  assert.equal(report.totals.outcomes.failure, 1);
  assert.equal(report.totals.compliant, 0);
  assert.equal(report.attempts[0].requiredSteps[0].status, 'cited-activity');
  assert.equal(report.attempts[0].reportedOutcome, 'success');
  assert.equal(report.attempts[0].reportedReason, 'caller-reported-result');
  assert.equal(report.attempts[0].outcome, 'unknown');
  assert.equal(report.attempts[0].workerId, observationId('w11:p2T'));
  assert.equal(report.attempts[0].workerIdentityProvenance, 'herdr-pane-observed');
  assert.equal(report.attempts[0].commandSubmissions, 1);
  assert.deepEqual(report.attempts[0].submittedSkills, ['how-pi']);
  const coordinator = { ...entries[0], kind: 'spawn', eventId: observationId('sdk-coordinator-spawn'),
    sessionId: observationId('sdk-coordinator'), paneId: observationId('w11:p2T'), role: 'implementation' };
  const joined = aggregateSkillObservations([...entries, coordinator]);
  assert.equal(joined.roles.implementation, 2);
  assert.equal(aggregateSkillObservations(entries).roles['not-captured'], 2);
  const custom = (data) => JSON.stringify({ type: 'custom', customType: 'agentic-driver.task-skill-observation.v1', data });
  await writeFile(resolve(cwd, 'worker.jsonl'), `${entries.map(custom).join('\n')}\n`);
  await writeFile(resolve(cwd, 'coordinator.jsonl'), `${custom(coordinator)}\n${custom(coordinator)}\n`);
  const cli = resolve('scripts/task_skill_observation_report.mjs');
  const first = execFileSync(process.execPath, [cli, resolve(cwd, 'worker.jsonl'), resolve(cwd, 'coordinator.jsonl')], { encoding: 'utf8' });
  const reversed = execFileSync(process.execPath, [cli, cwd], { encoding: 'utf8' });
  assert.equal(first, reversed);
  assert.equal(JSON.parse(first).roles.implementation, 2);
  assert.equal(JSON.parse(first).skills.commandSubmissions['how-pi'], 1);
  assert.equal(JSON.parse(first).sessions, 2);
  assert.ok(!entries.some((entry) => entry.ref === observationId('bdd-after-terminal')));
  assert.doesNotMatch(JSON.stringify(entries), /Neutral scripted|fixture\/leaf|offline fixture script|Continue the neutral task/);
  console.log(JSON.stringify({ fixture: 'fresh-pi-offline-faux', sdk: '1.5.0', toolResults: toolResults.length,
    providerCalls: faux.state.callCount, errors, report, aggregate: JSON.parse(first) }));
} finally { session.dispose(); }
