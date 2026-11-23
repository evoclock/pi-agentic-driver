// One local authority; no retries, background loops or alternative terminal path.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { run, readAuthorizedStatus } from './workflow_runner_core.mjs';
import { loadUserConfig } from './workflow_runner_user_config.mjs';
const SCHEMA = 'pad-worker-kind-adapter.v1';
const unavailable = () => ({ move: 'wait', reason: 'capability-unavailable', authorityCreated: false });
const internal = type => ({ id: `worker-${randomUUID()}`, type });

// Production callers use the existing guarded PAD boundaries. Pi nested calls
// retain native tool validation/hooks; CLI uses those same exported boundaries.
export function padWorkerDriver(context, nested, signal) {
  const call = async (name, params) => {
    if (nested) {
      const result = await nested(name, params, { signal });
      return result?.isError ? null : result?.details;
    }
    if (name === 'agentic_herdr_spawn_worker') {
      const { executeHerdrSpawnWorker } = await import('./enforcement/herdr_lifecycle_pi.js');
      return executeHerdrSpawnWorker(params, context, {}, signal);
    }
    const { executeHerdrCommunication } = await import('./enforcement/herdr_communication_pi.js');
    return executeHerdrCommunication(params, context, {}, signal);
  };
  return { schema: SCHEMA, kind: 'pi', host: 'local',
    modelAvailability: async route => {
      const [provider, ...parts] = route.split('/');
      if (!parts.length || typeof context?.modelRegistry?.find !== 'function') return { verified: false };
      return { verified: true, available: Boolean(context.modelRegistry.find(provider, parts.join('/'))) };
    },
    selectHarness: (kind, binding) => padHarnessDriver(kind, context, nested, signal, binding),
    spawn: request => call('agentic_herdr_spawn_worker', request.params),
    submit: request => call('agentic_herdr_communication', { action: 'submit', role: request.role, prompt: request.prompt, timeoutMs: 1000 }),
    delivery: deliveryId => call('agentic_herdr_communication', { action: 'delivery', deliveryId }),
  };
}

const hold = reason => ({ move: 'wait', reason, authorityCreated: false });
async function loadCodexSpawn() {
  // The complete #199 lifecycle wraps these launch/readback helpers; no second launcher.
  const [helper, lifecycle] = await Promise.all([import('./enforcement/codex_spawn_pi.js'), import('./enforcement/herdr_lifecycle_pi.js')]);
  if (typeof helper.codexLaunch !== 'function' || typeof helper.verifyCodexProcess !== 'function') return null;
  return lifecycle;
}

// Binding is configured caller input, separate from workflow/task text and prompts.
export async function padHarnessDriver(kind, context, nested, signal, binding, { loadSpawn = loadCodexSpawn } = {}) {
  if (!['pi', 'codex'].includes(kind)) return hold('harness-unavailable');
  if (binding?.kind !== undefined && binding.kind !== kind) return hold('harness-kind-mismatch');
  if (kind === 'pi') return padWorkerDriver(context, nested, signal);
  if (binding?.kind !== 'codex' || typeof binding.account !== 'string' || !binding.account.length ||
      typeof binding.authority?.ledgerId !== 'string' || !binding.authority.ledgerId.length) return hold('codex-binding-missing');
  let helper;
  try { helper = await loadSpawn(); } catch { return hold('harness-unavailable'); }
  if (typeof helper?.executeHerdrSpawnWorker !== 'function') return hold('harness-unavailable');
  const { account, authority } = binding;
  return { ...padWorkerDriver(context, nested, signal), kind: 'codex',
    spawn: request => helper.executeHerdrSpawnWorker({ ...request.params, kind, account, authority }, context, {}, signal),
  };
}

const validDriver = driver => driver?.schema === SCHEMA && ['pi', 'codex'].includes(driver.kind) && driver.host === 'local' &&
  ['spawn', 'submit', 'delivery'].every(key => typeof driver[key] === 'function');

export async function dispatchWorkflow(w, store, event, driver, { authority, harnessBinding, readUserConfig = loadUserConfig } = {}) {
  if (!['dispatch', 'delivery'].includes(event?.type)) throw new Error('invalid dispatch event');
  if (typeof driver !== 'function' && !validDriver(driver)) return unavailable();
  const select = async kind => {
    try {
      if (typeof driver === 'function') return await driver(kind, harnessBinding);
      return typeof driver.selectHarness === 'function' ? await driver.selectHarness(kind, harnessBinding) : driver;
    } catch { return hold('harness-unavailable'); }
  };
  const before = await readAuthorizedStatus(w, store, authority);
  if (before.move === 'wait') return before;
  if (!before.intent || !['awaiting', 'parked'].includes(before.phase)) return { move: 'wait', reason: 'dispatch-unavailable', authorityCreated: false };
  const intent = before.intent;
  // The input tuple is the one durably issued by the runner, not caller JSON.
  const current = async () => {
    const state = await readAuthorizedStatus(w, store, authority);
    return ['awaiting', 'parked'].includes(state.phase) && state.epoch === intent.epoch &&
      state.intent?.dispatchId === intent.dispatchId && state.intent.writerId === intent.writerId;
  };
  const record = observation => run(w, store, internal('_worker'), { authority, workerObservation: () => observation });
  if (event.type === 'delivery') {
    // Reserve the event id with a harmless observation before a read-only query.
    const seen = await run(w, store, { ...event, type: 'look' }, { authority });
    if (seen.duplicate || !intent.deliveryId || !intent.workerBinding) return seen;
    const selected = await select(intent.stack.harness.kind);
    if (!validDriver(selected) || selected.kind !== intent.stack.harness.kind) return record({ ...intent.workerBinding, status: 'harness-unavailable' });
    let observed;
    try { observed = await selected.delivery(intent.deliveryId); } catch { observed = null; }
    if (!(await current())) return { move: 'wait', reason: 'dispatch-fenced', authorityCreated: false };
    return record({ ...intent.workerBinding, status: observed?.ok === true && observed.deliveryId === intent.deliveryId &&
      observed.role === intent.worker.role && observed.agentKind === selected.kind && observed.deliveryState === 'answered'
      ? 'answered' : 'unknown', deliveryId: observed?.deliveryId });
  }
  // Policy selection is before the durable effect claim. No spawn outcome can
  // trigger fallback; unverified availability retains the declared route.
  let model = intent.model ?? intent.worker.model;
  if (!intent.workerStage) {
    const config = await readUserConfig(), policy = config.model?.policy ?? 'subscription';
    if (policy === 'local') model = config.model.localRoute;
    if (policy === 'local-fallback' && typeof driver.modelAvailability === 'function') {
      let available; try { available = await driver.modelAvailability(model); } catch { available = null; }
      if (available?.verified === true && available.available === false) model = config.model.localRoute;
    }
    if (!['subscription', 'local', 'local-fallback'].includes(policy) || typeof model !== 'string' || !model.length || model.length > 192 || /[\u0000\r\n]/.test(model)) throw Error('invalid model policy');
  }
  if (!(await current())) return { move: 'wait', reason: 'dispatch-fenced', authorityCreated: false };
  const claim = await run(w, store, event, { authority, dispatchModel: () => model });
  if (claim.move !== 'spawn' || claim.duplicate) return claim;
  const issued = claim.intent;
  const binding = issued.workerBinding;
  const selected = await select(issued.stack.harness.kind);
  if (!validDriver(selected)) {
    const parked = await record({ ...binding, status: 'harness-unavailable' });
    return { ...parked, harnessHold: selected?.reason ?? 'harness-unavailable' };
  }
  driver = selected;
  if (issued.stack.harness.kind !== driver.kind) return record({ ...binding, status: 'harness-unavailable' });
  if (!(await current())) return { move: 'wait', reason: 'dispatch-fenced', authorityCreated: false };
  let spawned;
  try { spawned = await selected.spawn({ binding, params: { placement: 'tab', role: issued.worker.role,
    model: issued.model, repository: issued.worker.repository, worktreePath: w.repo,
    ...(issued.worker.workspace ? { workspace: issued.worker.workspace } : {}) } }); }
  catch { spawned = null; }
  if (selected.kind === 'codex' && spawned?.status === 'denied') return record({ ...binding, status: 'harness-unavailable' });
  const target = spawned?.worktreePath ?? spawned?.repository;
  if (!(spawned?.ok === true && spawned.status === 'spawned' && spawned.role === issued.worker.role &&
      typeof spawned.paneId === 'string' && spawned.paneId.length > 0 && typeof target === 'string' && resolve(target) === resolve(w.repo))) {
    return record({ ...binding, status: 'unknown' });
  }
  if (!(await current())) return { move: 'wait', reason: 'dispatch-fenced', authorityCreated: false };
  await record({ ...binding, status: 'spawned', paneId: spawned.paneId });
  const promptClaim = await run(w, store, internal('_prompt'), { authority });
  if (promptClaim.move !== 'submit' || promptClaim.duplicate || !(await current())) return promptClaim;
  const prompt = 'Execute only this frozen workflow step within its declared artifact scope. Do not push, open a PR, merge or change other files. Report the resulting commit; host checks run independently.\n' +
    JSON.stringify({ schema: 'pad-worker-step.v1', runnerRunId: store.split('/').at(-1), binding, branch: issued.branch, base: issued.base,
      artifact: w.steps[before.step].artifact,
      ...(w.spec ? { outputContract: { schema: 'pad-worker-output.v1', paths: [w.steps[before.step].artifact], acceptance: 'frozen-checks', receipt: 'outputs' } } : { sha256: w.steps[before.step].sha256 }),
      skill: w.steps[before.step].skill, procedure: w.steps[before.step].procedure, stack: issued.stack, gaps: issued.gaps });
  let delivery;
  try { delivery = await selected.submit({ binding, role: issued.worker.role, paneId: spawned.paneId, prompt }); }
  catch { delivery = null; }
  if (!(await current())) return { move: 'wait', reason: 'dispatch-fenced', authorityCreated: false };
  return record({ ...binding, status: delivery?.ok === true && delivery.status === 'accepted' &&
    delivery.role === issued.worker.role && typeof delivery.deliveryId === 'string' && delivery.deliveryId.length > 0
    ? 'submitted' : 'unknown', deliveryId: delivery?.deliveryId });
}
