// Pi facade over the durable reducer and guarded one-use worker adapter.
import { Type } from 'typebox';
import { resolve, join } from 'node:path';
import { run, readAuthorizedStatus } from '../scripts/workflow_runner_core.mjs';
import { authorityForRepository } from '../scripts/workflow_runner_authority.mjs';
import { dispatchWorkflow, padWorkerDriver } from '../scripts/workflow_runner_dispatch.mjs';
import { specGateWorkflow } from '../scripts/workflow_runner_spec.mjs';
import { exitGateWorkflow } from '../scripts/workflow_runner_exit.mjs';

const identity = { workflow: Type.Any(), taskId: Type.String({ minLength: 1, maxLength: 81 }) };
const eventId = Type.String({ minLength: 1, maxLength: 81 });
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const refuse = (reason) => result({ schema: 'pad-workflow-tool.v1', status: 'unavailable', reason, authorityCreated: false });

export default function workflowRunner(pi, dependencies = {}) {
  const authorityFor = dependencies.authorityForRepository ?? authorityForRepository;
  const scope = (params, ctx) => {
    if (typeof ctx.isProjectTrusted !== 'function' || !ctx.isProjectTrusted() ||
        !params.workflow || typeof params.workflow !== 'object' || Array.isArray(params.workflow) ||
        resolve(params.workflow.repo ?? '') !== resolve(ctx.cwd) ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(params.taskId)) {
      throw new Error('workflow repo must be the current trusted checkout; task ID must be one segment');
    }
    const store = join(ctx.cwd, '.local', 'workflow-runner', params.taskId);
    if (JSON.stringify(params.workflow).length > 32768) throw new Error('workflow too large');
    return store;
  };
  const event = (input, allowed) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(input.id ?? '') ||
        !allowed.includes(input.type) || JSON.stringify(input).length > 8192) throw new Error('invalid bounded workflow event');
    return input;
  };
  const common = { namespace: { name: 'agentic-workflow', description: 'Voluntary PAD workflow decisions; never grants effect authority.' },
    annotations: { openWorldHint: false, destructiveHint: false }, executionMode: 'sequential' };
  pi.registerTool({ ...common, name: 'agentic_workflow_run', label: 'Workflow Run',
    description: 'Record one non-authorizing initial workflow tick in the current checkout. Does not spawn a worker.',
    parameters: Type.Object({ ...identity, eventId }),
    async execute(_id, params, _signal, _update, ctx) {
      const store = scope(params, ctx);
      return result(await run(params.workflow, store, { id: params.eventId, type: 'tick' }, { authority: await authorityFor(ctx.cwd) }));
    } });
  pi.registerTool({ ...common, name: 'agentic_workflow_tick', label: 'Workflow Tick',
    description: 'Submit one bounded observation or tick to the same durable reducer. Worker reports and PR prose cannot prove steps.',
    parameters: Type.Object({ ...identity, event: Type.Any() }),
    async execute(_id, params, _signal, _update, ctx) {
      const store = scope(params, ctx);
      return result(await run(params.workflow, store, event(params.event, ['tick', 'receipt', 'wake', 'look', 'procedure']), { authority: await authorityFor(ctx.cwd) }));
    } });
  pi.registerTool({ ...common, name: 'agentic_workflow_dispatch', label: 'Workflow Dispatch',
    description: 'Claim one worker effect durably, then use guarded spawn and communication once. Unknown effects park without retry.',
    exposure: 'model-only',
    reachesTools: () => ['agentic_herdr_spawn_worker', 'agentic_herdr_communication'],
    parameters: Type.Object({ ...identity, event: Type.Any() }),
    async execute(_id, params, signal, _update, ctx) {
      const store = scope(params, ctx);
      const input = event(params.event, ['dispatch', 'delivery']);
      if (typeof ctx.executeTool !== 'function') return refuse('capability-unavailable');
      return result(await dispatchWorkflow(params.workflow, store, input,
        padWorkerDriver(ctx, ctx.executeTool.bind(ctx), signal), { authority: await authorityFor(ctx.cwd), readUserConfig: dependencies.readUserConfig }));
    } });
  pi.registerTool({ ...common, name: 'agentic_workflow_gate', label: 'Workflow Gate',
    exposure: 'model-only', reachesTools: () => ['agentic_linux_microvm_checks'],
    description: 'Run host spec checks on the pinned design bundle before worker dispatch. Records evidence and grants nothing.',
    parameters: Type.Object({ ...identity, event: Type.Any() }),
    async execute(_id, params, signal, _update, ctx) {
      const store = scope(params, ctx);
      const input = event(params.event, ['spec', 'checks']);
      const gate = input.type === 'checks' ? exitGateWorkflow : specGateWorkflow;
      return result(await gate(params.workflow, store, input, { ...(input.type === 'checks' ? dependencies.exit : dependencies.spec), signal,
        runLinuxChecks: async runId => {
          if (typeof ctx.executeTool !== 'function') return { verdict: 'runner-unavailable', parkReason: 'checks-runner-unavailable' };
          const observed = await ctx.executeTool('agentic_linux_microvm_checks', { runId }, { signal });
          return observed?.isError ? null : observed?.details;
        }, authority: await authorityFor(ctx.cwd) }));
    } });
  pi.registerTool({ ...common, name: 'agentic_workflow_status', label: 'Workflow Status',
    description: 'Read authority-checked workflow status and refresh its local high-water cache; grants no effect authority.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object(identity),
    async execute(_id, params, _signal, _update, ctx) {
      const store = scope(params, ctx);
      return result(await readAuthorizedStatus(params.workflow, store, await authorityFor(ctx.cwd)));
    } });
  pi.registerTool({ ...common, name: 'agentic_workflow_cancel', label: 'Workflow Cancel',
    description: 'Ask the owner through a native confirmation before fencing this workflow.',
    parameters: Type.Object({ ...identity, eventId }),
    async execute(_id, params, _signal, _update, ctx) {
      const store = scope(params, ctx);
      if (!ctx.hasUI || !await ctx.ui.confirm('Cancel workflow?', `Fence ${params.taskId} in ${ctx.cwd}?`)) return refuse('owner-confirmation-required');
      return result(await run(params.workflow, store, { id: params.eventId, type: 'cancel' }, { authority: await authorityFor(ctx.cwd) }));
    } });
}
