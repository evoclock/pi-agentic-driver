import { pathToFileURL } from 'node:url';
import { basename, resolve } from 'node:path';

// The configured module is the existing agent-evals session exporter, not a second transport.
export async function observeRunner(workflow, runId, event, outcome) {
  const modulePath = process.env.PAD_LANGFUSE_SESSION_MODULE;
  if (!modulePath) return;
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) throw Error('runner Langfuse credentials unavailable');
  const { exportRunnerEvent } = await import(pathToFileURL(resolve(modulePath)).href);
  if (typeof exportRunnerEvent !== 'function') throw Error('runner Langfuse contract unavailable');
  const step = workflow.steps?.find(s => s.id === outcome?.intent?.stepId) ?? workflow.steps?.[outcome?.step];
  const kind = event.type === 'compile' ? 'compile' : event.type === 'receipt' ? 'receipt' : ['dispatch', 'delivery'].includes(event.type) ? 'dispatch' : 'tick';
  return exportRunnerEvent({runId, workflow: basename(workflow.repo), eventId: event.id, kind,
    stepId: step?.id, skill: step?.skill?.step,
    stepIds: workflow.steps.map(s => s.id), skills: workflow.steps.map(s => s.skill.step)});
}
