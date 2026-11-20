#!/usr/bin/env node
// Closed-input, one-event-per-invocation PAD workflow runner CLI.
import { readFileSync } from 'node:fs';
import { run } from './workflow_runner_core.mjs';
import { authorityForRepository } from './workflow_runner_authority.mjs';
import { dispatchWorkflow, padWorkerDriver } from './workflow_runner_dispatch.mjs';
import { specGateWorkflow } from './workflow_runner_spec.mjs';
import { exitGateWorkflow } from './workflow_runner_exit.mjs';
import { resolve } from 'node:path';

try {
  const args = process.argv.slice(2);
  if (args[0] !== 'run' || args.length !== 9 || args[1] !== '--workflow' || args[3] !== '--run-id' || args[5] !== '--event' || args[7] !== '--store') throw new Error('usage: pad-runner run --workflow FILE --run-id ID --event FILE --store DIR');
  const [, , workflowFile, , runId, , eventFile, , root] = args;
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(runId)) throw new Error('invalid run id');
  const workflow = JSON.parse(readFileSync(workflowFile, 'utf8'));
  const event = JSON.parse(readFileSync(eventFile, 'utf8'));
  // No noninteractive owner approval or trusted readback adapter exists on this surface.
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(event.id ?? '') ||
      !['tick', 'receipt', 'wake', 'look', 'procedure', 'dispatch', 'delivery', 'spec', 'checks'].includes(event.type) || JSON.stringify(event).length > 8192)
    throw new Error('workflow event unavailable on noninteractive CLI');
  const authority = await authorityForRepository(workflow.repo);
  const effect = ['dispatch', 'delivery'].includes(event.type);
  if ((effect || event.type === 'spec' || event.type === 'checks') && resolve(workflow.repo) !== resolve(process.cwd())) throw new Error('worker dispatch requires the current checkout');
  const result = effect
    ? await dispatchWorkflow(workflow, `${root}/${runId}`, event, padWorkerDriver({ cwd: process.cwd(), hasUI: false }), { authority })
    : event.type === 'spec' ? await specGateWorkflow(workflow, `${root}/${runId}`, event, { authority })
    : event.type === 'checks' ? await exitGateWorkflow(workflow, `${root}/${runId}`, event, { authority })
    : await run(workflow, `${root}/${runId}`, event, { authority });
  process.stdout.write(JSON.stringify({ schema: 'pad-runner.result.v1', runId, ...result, authorityCreated: false }) + '\n');
} catch (error) {
  process.stderr.write(`pad-runner: ${error.message}\n`);
  process.exitCode = 2;
}
