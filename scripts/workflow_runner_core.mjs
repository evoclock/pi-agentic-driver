// A bounded PAD-owned workflow runner. External text is evidence, never a grant.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync, renameSync, fsyncSync, mkdirSync, existsSync, realpathSync, lstatSync, fstatSync, readdirSync, unlinkSync, linkSync, constants } from 'node:fs';
import { dirname, join, resolve, relative, posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ownershipOf, staleOwnershipIntent, ownerObserved, ownershipMove, ownershipReplay } from './workflow_runner_ownership.mjs';
import { validProcedure, procedureRequest, observeProcedure, matchingProcedure } from './workflow_runner_procedure.mjs';
import { authorityGate, thenResult, retainWriter } from './workflow_runner_authority_gate.mjs';
import { validSpecRef, specRequest, matchingSpec } from './workflow_runner_spec.mjs';
import { validProgress, exitRequest, matchingExit, returnHandoverConsumed } from './workflow_runner_exit.mjs';
import { loadUserConfig } from './workflow_runner_user_config.mjs';
import { recordOutputs, sameOutputs, outputsDigest, outputSnapshotMatches } from './workflow_runner_outputs.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const seal = (key, body) => createHmac('sha256', Buffer.from(key, 'hex')).update(canonical(body)).digest('hex');
const canonical = (value) => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
// Bind every checked procedure/artifact pair independently. Caller labels, expected
// output bytes, step-list padding, revisions and attempt ceilings cannot undo cancel.
// The index is private to this checkout, not a cross-checkout authority boundary.
const workflowIdentities = (w) => [...new Set(w.steps.map(s => sha(canonical({
  repo: w.repo, artifact: posix.normalize(s.artifact).replace(/\/+$/, '').toLowerCase(),
  skill: { path: posix.normalize(s.skill.path).toLowerCase(), sha256: s.skill.sha256,
    step: s.skill.step.toLowerCase() },
}))))];
const workflowIdentity = (w) => workflowIdentities(w)[0];
const readSafe = (path) => { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { if (!lstatSync(path).isFile()) fail('unsafe state file'); return readFileSync(fd, 'utf8'); } finally { closeSync(fd); } };
const hex = /^[0-9a-f]{40}$/;
const digest = /^[0-9a-f]{64}$/;
const id = /^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/;
const fail = (message) => { throw new Error(message); };
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2e6 }).trim();

export function validateWorkflow(w) {
  if (w && w.maxAttempts === undefined) w = { ...w, maxAttempts: Math.min(100, loadUserConfig().attempts?.max ?? 2) };
  if (w?.schema !== 'pad-workflow.v1' || Object.keys(w).some(k => !['schema', 'repo', 'revision', 'steps', 'maxAttempts', 'spec', 'progress'].includes(k)) || !hex.test(w.revision ?? '') || !w.repo || !Array.isArray(w.steps) || !w.steps.length || w.steps.length > 12 || !Number.isSafeInteger(w.maxAttempts) || w.maxAttempts < 1 || w.maxAttempts > 100) fail('invalid workflow');
  if (w.progress !== undefined && !validProgress(w.progress)) fail('invalid progress');
  if (w.spec !== undefined && !validSpecRef(w.spec)) fail('invalid spec reference');
  const root = git(w.repo, 'rev-parse', '--show-toplevel');
  if (resolve(root) !== resolve(w.repo)) fail('workflow repository must be its canonical root');
  try { if (git(root, 'cat-file', '-t', w.revision) !== 'commit') fail('workflow revision must be a commit'); }
  catch { fail('workflow revision must be a commit'); }
  try { git(root, 'merge-base', '--is-ancestor', w.revision, 'HEAD'); } catch { fail('workflow revision must precede current head'); }
  const names = new Set();
  for (const s of w.steps) {
    if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !['id', 'artifact', 'sha256', 'skill', 'procedure', 'worker'].includes(k)) ||
        !id.test(s.id ?? '') || names.has(s.id) || !s.skill || typeof s.skill !== 'object' || Array.isArray(s.skill) ||
        Object.keys(s.skill).some(k => !['pack', 'version', 'path', 'sha256', 'step'].includes(k)) ||
        !id.test(s.skill.pack ?? '') || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(s.skill.version ?? '') || !digest.test(s.skill.sha256 ?? '') || !id.test(s.skill.step ?? '')) fail('invalid skill step');
    if (s.procedure !== undefined && !validProcedure(s.procedure)) fail('invalid procedure requirement');
    if (s.worker !== undefined && (!s.worker || s.worker.schema !== 'pad-worker.v1' ||
        Object.keys(s.worker).some(k => !['schema', 'role', 'model', 'repository', 'workspace'].includes(k)) ||
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(s.worker.role ?? '') || s.worker.role.length > 64 ||
        typeof s.worker.model !== 'string' || !s.worker.model.length || s.worker.model.length > 192 ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(s.worker.repository ?? '') ||
        (s.worker.workspace !== undefined && (typeof s.worker.workspace !== 'string' || s.worker.workspace.length > 128)))) fail('invalid worker contract');
    names.add(s.id);
    if (!s.skill.path || s.skill.path.startsWith('/') || s.skill.path.split('/').includes('..')) fail('invalid skill path');
    if (!/^[a-zA-Z0-9._/-]+$/.test(s.artifact ?? '') || s.artifact.startsWith('/') || s.artifact.split('/').includes('..') ||
        s.artifact !== posix.normalize(s.artifact) || s.artifact.endsWith('/') || !digest.test(s.sha256 ?? '')) fail('invalid artifact contract');
    // Skill identity is checked at activation; a receipt cannot invent a new procedure.
    const skillPath = resolve(root, s.skill.path);
    if (!relative(root, skillPath) || relative(root, realpathSync(skillPath)).startsWith('..') || sha(readFileSync(skillPath)) !== s.skill.sha256) fail('skill content mismatch');
    try { git(root, 'ls-files', '--error-unmatch', '--', s.skill.path); } catch { fail('skill must be tracked in Git'); }
    let pinned;
    try { pinned = execFileSync('git', ['-C', root, 'show', `${w.revision}:${s.skill.path}`], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2e6 }); }
    catch { fail('skill procedure must exist in the frozen revision'); }
    if (sha(pinned) !== s.skill.sha256 || !pinned.toString('utf8').split(/\r?\n/).some(line => line.trim().toLowerCase() === `## step: ${s.skill.step.toLowerCase()}`)) fail('skill procedure declaration mismatch');
  }
  return { ...w, repo: root };
}

export function verifyReceipt(w, state, receipt) {
  const step = w.steps[state.step];
  const intent = state.intent;
  if (!step || !intent || !id.test(intent.dispatchId ?? '') || intent.dispatchId === '0' ||
      receipt?.stepId !== step.id || intent.stepId !== step.id || receipt.dispatchId !== intent.dispatchId ||
      receipt.epoch !== state.epoch || receipt.dispatchEpoch !== intent.epoch || intent.epoch !== state.epoch ||
      receipt.dispatchWriter !== intent.writerId || receipt.writerId !== intent.writerId ||
      staleOwnershipIntent(state) || (ownershipOf(state).managed && receipt.ownerGeneration !== intent.ownerGeneration) ||
      receipt.actor !== intent.actor || receipt.branch !== intent.branch ||
      receipt.stepBaseHead !== intent.base || receipt.revision !== w.revision ||
      receipt.skillRef !== `${step.skill.pack}/${step.skill.version}/${step.skill.step}` ||
      !hex.test(receipt.commit ?? '')) return false;
  try {
    if (git(w.repo, 'cat-file', '-t', receipt.commit) !== 'commit') return false;
    if (git(w.repo, 'rev-parse', 'HEAD') !== receipt.commit || receipt.commit === intent.base ||
        git(w.repo, 'symbolic-ref', '--quiet', '--short', 'HEAD') !== intent.branch) return false;
    git(w.repo, 'merge-base', '--is-ancestor', intent.base, receipt.commit);
    const changed = git(w.repo, 'diff', '--name-only', intent.base, receipt.commit).split('\n');
    if (changed.length !== 1 || changed[0] !== step.artifact) return false;
    if (w.spec && step.worker) {
      const outputs = recordOutputs(w.repo, receipt.commit, [step.artifact]);
      // Old fixed-byte receipts remain admissible, but cannot name different bytes.
      if (receipt.outputs === undefined ? outputs[0].sha256 !== step.sha256 : !sameOutputs(receipt.outputs, outputs)) return false;
      if (!outputSnapshotMatches(w.repo, receipt.commit, outputs)) return false;
    } else if (sha(execFileSync('git', ['-C', w.repo, 'show', `${receipt.commit}:${step.artifact}`], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2e6 })) !== step.sha256) return false;
    return receipt.check === 'git-object-content';
  } catch { return false; }
}

export function verifyWake(w, s, event) {
  try {
    if (event.source === 'commit') {
      if (!s.intent || !hex.test(event.commit ?? '') || git(w.repo, 'rev-parse', 'HEAD') !== event.commit || event.commit === s.intent.base) return false;
      git(w.repo, 'merge-base', '--is-ancestor', s.intent.base, event.commit);
      return git(w.repo, 'diff', '--name-only', s.intent.base, event.commit, '--', w.steps[s.step].artifact).split('\n').includes(w.steps[s.step].artifact);
    }
    // PR/worker wakes need a task-bound trusted adapter; never infer attribution from caller JSON.
  } catch { return false; }
  return false;
}

export const initial = (w) => ({ schema: 'pad-run.v1', revision: w.revision, contractDigest: sha(canonical(w)),
  phase: 'ready', step: 0, epoch: 0, writerId: `writer-${sha(canonical(w)).slice(0, 20)}`,
  ownership: { ownerId: `writer-${sha(canonical(w)).slice(0, 20)}`, generation: 0, managed: false },
  attempts: w.steps.map(() => 0), looks: 0, pending: null, wake: null, intent: null, spec: null, exit: null, seen: {}, history: [] });

const pendingMatches = (w, s) => s.intent && s.pending &&
  id.test(s.intent.dispatchId ?? '') && s.intent.dispatchId !== '0' &&
  s.intent.stepId === w.steps[s.step]?.id && s.pending.stepId === s.intent.stepId &&
  s.pending.dispatchId === s.intent.dispatchId && s.pending.epoch === s.epoch &&
  s.pending.writerId === s.intent.writerId && s.pending.stepBaseHead === s.intent.base;

// Pure: one tick chooses exactly one move; observations and handbrake enter separately.
function procedureVerified(w, s, commit = s.pending?.commit ?? s.procedureEvidence?.commit) {
  if (!s.procedureEvidence || !commit) return false;
  return matchingProcedure(procedureRequest(w, s, commit), s.procedureEvidence, {}) &&
    s.consumedProcedure?.[s.procedureEvidence.evidenceId] === true;
}

const needsSpec = w => w.steps.some(step => step.worker);
const specPassed = (w, s) => s.spec?.verdict === 'pass' && s.spec.manifestSha256 === w.spec?.sha256 && s.spec.chartSha256 === s.spec.confirmedChartSha256;

const exitRequired = (w, s) => Boolean(w.spec) && Boolean(w.steps[s.step]?.worker);
function checksPassed(w, s) {
  if (!(s.exit?.verdict === 'pass' && (s.exit.gaps?.gapSet?.length ?? 0) === 0 && s.exit.binding.commit === s.pending?.commit && s.exit.binding.dispatchId === s.intent?.dispatchId && s.exit.binding.epoch === s.epoch && s.exit.binding.writerId === s.intent?.writerId)) return false;
  // Pre-upgrade pending receipts certified the fixed SHA; new receipts always
  // retain observed outputs, including when their bytes equal that old SHA.
  const outputs = s.pending.outputs ?? [{ path: w.steps[s.step].artifact, sha256: w.steps[s.step].sha256 }];
  if (s.pending.outputs && s.exit.binding.outputsDigest !== outputsDigest(outputs)) return false;
  return outputSnapshotMatches(w.repo, s.pending.commit, outputs);
}

export function decide(w, s) {
  if (['done', 'cancelled', 'held', 'exhausted'].includes(s.phase)) return { move: 'settled', reason: s.phase };
  if (ownershipOf(s).ownerId === null) return { move: 'wait', phase: 'parked', reason: 'ownership-released' };
  if (staleOwnershipIntent(s)) return { move: 'wait', phase: 'parked', reason: 'old-effect-reconciliation-required' };
  if (s.pending && pendingMatches(w, s) && ['awaiting', 'parked'].includes(s.phase)) {
    if (exitRequired(w, s) && !checksPassed(w, s)) return { move: 'wait', reason: s.exit?.parkReason ?? 'checks-required', ...(s.exit?.parkReason ? { phase: 'parked' } : {}) };
    const checked = procedureVerified(w, s, s.pending.commit);
    if (w.steps[s.step].procedure && !checked) return { move: 'wait', reason: 'procedure-required' };
    return { move: 'advance', phase: s.step === w.steps.length - 1 ? 'done' : 'ready', stepId: w.steps[s.step].id, procedureVerified: checked };
  }
  if (s.phase === 'parked') return s.wake ? { move: 'wait', phase: s.intent ? 'awaiting' : 'ready', reason: 'verified-wake' } : { move: 'wait', phase: 'parked', reason: 'no-new-evidence' };
  if (needsSpec(w) && !specPassed(w, s)) return { move: 'wait', phase: 'parked', reason: w.spec ? (s.spec?.reason ?? 'spec-unchecked') : 'spec-missing' };
  if (s.phase === 'ready' && s.exit?.handoverPath && !s.exit.handoverConsumed) return { move: 'wait', reason: 'handover-unconsumed' };
  if (s.phase === 'ready' && s.intent) return { move: 'wait', phase: 'parked', reason: 'unconfirmed-effect' };
  if (s.phase === 'ready') return !s.exit?.retry && s.attempts[s.step] >= Math.min(100, w.maxAttempts)
    ? { move: 'settled', phase: 'exhausted', reason: 'attempt-budget' }
    : { move: 'act', phase: 'awaiting', stepId: w.steps[s.step].id };
  return { move: 'wait', phase: 'parked', reason: 'unconfirmed-effect' };
}

export function transition(w, previous, event, adapter = {}) {
  const s = structuredClone({ spec: null, exit: null, ...previous });
  if (s.revision !== w.revision || s.contractDigest !== sha(canonical(w)) || !id.test(event?.id ?? '')) fail('event or workflow revision mismatch');
  const key = event.id;
  const signature = sha(canonical(event));
  if (s.seen[key]) {
    if (s.seen[key] !== signature) fail('event-id conflict');
    const original = s.history.find(h => h.id === key)?.result;
    if (!original) fail('missing original event result');
    const result = ['cancelled', 'held'].includes(s.phase)
      ? { move: 'settled', reason: s.phase, authorityCreated: false, duplicate: true }
      : ownershipReplay(s, original) ?? { ...original, duplicate: true };
    return { state: previous, result, duplicate: true };
  }
  // Settled owner controls are semantic no-ops, not new event admissions.
  if (['cancel', 'hold'].includes(event.type) &&
      ['done', 'held', 'cancelled', 'exhausted'].includes(s.phase))
    return { state: previous, result: { move: 'settled', reason: s.phase,
      phase: s.phase, step: s.step, epoch: s.epoch, looks: s.looks,
      attempts: s.attempts[s.step] ?? s.attempts.at(-1) ?? 0,
      procedureDeclared: true, procedureVerified: false,
      authorityCreated: false, duplicate: true }, duplicate: true };
  let result;
  switch (event.type) {
    case 'release-ownership':
    case 'transfer-ownership':
    case 'reconcile-old':
      result = ownershipMove(s, event, adapter); break;
    case 'tick': {
      if (s.exit?.handoverPath && !s.exit.handoverConsumed && typeof adapter.handoverConsumed === 'function') s.exit.handoverConsumed = adapter.handoverConsumed(s.exit) === true;
      result = decide(w, s);
      if (['act', 'advance'].includes(result.move) && !ownerObserved(s, adapter)) {
        result = { move: 'wait', reason: 'ownership-fenced' }; break;
      }
      if (result.move === 'act') {
        // This PAD-issued identifier binds a dispatch intent, not proof a worker executed it.
        s.procedureEvidence = null;
        s.intent = { taskId: adapter.taskId ?? null, stepId: result.stepId, dispatchId: `dispatch-${randomUUID()}`,
          epoch: s.epoch, writerId: s.writerId, ownerGeneration: ownershipOf(s).generation, actor: 'pad-runner', eventId: key,
          branch: git(w.repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'),
          base: git(w.repo, 'rev-parse', 'HEAD'), ack: false,
          ...(w.steps[s.step].worker ? { worker: structuredClone(w.steps[s.step].worker),
            adapterRevision: 'pad-worker-kind-adapter.v1', host: 'local', kind: 'pi' } : {}) };
        if (!s.exit?.retry) s.attempts[s.step]++;
        if (s.exit) s.exit.retry = false;
        result.intent = s.intent;
      }
      if (result.move === 'advance') { s.step++; s.pending = null; s.intent = null; s.wake = null; }
      if (result.reason === 'verified-wake') s.wake = null;
      s.phase = result.phase ?? s.phase;
      break;
    }
    case 'spec': {
      const request = specRequest(w, { ...s, taskId: adapter.taskId });
      if (!request) { result = { move: 'wait', reason: needsSpec(w) ? (w.spec ? 'spec-unavailable' : 'spec-missing') : 'spec-not-required' }; break; }
      s.specClaim = { eventId: key, binding: request.binding };
      result = { move: 'wait', reason: 'spec-check-claimed', request }; break;
    }
    case '_spec': {
      if (!adapter.specEventId || s.specClaim?.eventId !== adapter.specEventId) { result = { move: 'wait', reason: 'spec-observation-rejected' }; break; }
      const request = specRequest(w, { ...s, taskId: adapter.taskId ?? s.taskId });
      const observed = typeof adapter.specObservation === 'function' ? adapter.specObservation() : null;
      if (!matchingSpec(request, observed, s.consumedSpec ?? {})) { s.specClaim = null; result = { move: 'wait', reason: 'spec-observation-rejected' }; break; }
      s.consumedSpec ??= {}; s.consumedSpec[observed.evidenceId] = true;
      s.spec = structuredClone(observed);
      if (observed.verdict === 'pass' && !s.intent && s.phase === 'parked') s.phase = 'ready';
      if (observed.verdict !== 'pass') s.phase = 'parked';
      s.specClaim = null;
      result = { move: 'wait', reason: observed.reason ?? 'spec-verified' }; break;
    }
    case 'checks': {
      if (['cancelled', 'held', 'done', 'exhausted'].includes(s.phase)) { result = { move: 'settled', reason: s.phase }; break; }
      if (s.exitClaim) { s.phase = 'parked'; result = { move: 'wait', reason: 'checks-effect-unknown' }; break; }
      const request = exitRequest(w, { ...s, taskId: adapter.taskId ?? s.taskId });
      if (!request) { result = { move: 'wait', reason: 'checks-unavailable' }; break; }
      if (request.park) { s.exit = { verdict: 'incomplete', parkReason: request.park }; s.phase = 'parked'; result = { move: 'wait', reason: request.park }; break; }
      s.exitClaim = { eventId: key, binding: request.binding };
      result = { move: 'wait', reason: 'checks-claimed', request }; break;
    }
    case '_checks': {
      if (['cancelled', 'held', 'done', 'exhausted'].includes(s.phase)) { result = { move: 'settled', reason: s.phase }; break; }
      if (!adapter.checksEventId || s.exitClaim?.eventId !== adapter.checksEventId) { result = { move: 'wait', reason: 'checks-observation-rejected' }; break; }
      const request = exitRequest(w, { ...s, taskId: adapter.taskId ?? s.taskId });
      const observed = typeof adapter.exitObservation === 'function' ? adapter.exitObservation() : null;
      if (!matchingExit(request, observed, s.consumedExit ?? {}) || !Object.entries(s.exitClaim.binding).every(([k,v]) => observed.binding[k] === v)) { s.phase = 'parked'; result = { move: 'wait', reason: 'checks-observation-rejected' }; break; }
      s.consumedExit ??= {}; s.consumedExit[observed.evidenceId] = true; s.exitClaim = null;
      s.exit = structuredClone(observed);
      if (observed.verdict === 'fail' && observed.handoverPath) {
        s.exit.retry = true; s.exit.handoverConsumed = false; s.pending = null; s.intent = null; s.wake = null; s.phase = 'ready'; result = { move: 'wait', reason: 'checks-failed-returned' };
      } else if (observed.verdict === 'pass') { result = { move: 'wait', reason: 'checks-verified' }; }
      else { s.phase = 'parked'; s.exit.parkReason ??= 'checks-incomplete'; result = { move: 'wait', reason: s.exit.parkReason }; }
      break;
    }
    case 'dispatch': {
      if (s.exit?.handoverPath && !s.exit.handoverConsumed) { result = { move: 'wait', reason: 'handover-unconsumed' }; break; }
      if (!specPassed(w, s)) { result = { move: 'wait', reason: 'spec-required' }; break; }
      if (!s.intent || !['awaiting', 'parked'].includes(s.phase) || !s.intent.worker ||
          s.intent.epoch !== s.epoch || s.intent.writerId !== s.writerId) { result = { move: 'wait', reason: 'dispatch-unavailable' }; break; }
      if (!validProcedure(w.steps[s.step].procedure)) { result = { move: 'wait', reason: 'procedure-required' }; break; }
      if (git(w.repo, 'rev-parse', 'HEAD') !== s.intent.base ||
          git(w.repo, 'symbolic-ref', '--quiet', '--short', 'HEAD') !== s.intent.branch) {
        result = { move: 'wait', reason: 'dispatch-input-changed' }; break;
      }
      if (s.intent.workerStage) { s.phase = 'parked'; result = { move: 'wait', reason: 'effect-already-claimed' }; break; }
      const request = procedureRequest(w, s, s.intent.base);
      s.intent.model = typeof adapter.dispatchModel === 'function' ? adapter.dispatchModel() : s.intent.worker.model;
      s.intent.stack = structuredClone(s.spec.derived);
      s.intent.gaps = s.exit?.gaps ?? null;
      s.intent.workerBinding = request?.binding;
      s.intent.workerStage = 'claimed'; s.phase = 'parked';
      result = { move: 'spawn', intent: structuredClone(s.intent) }; break;
    }
    case '_worker': {
      const intent = s.intent, request = procedureRequest(w, s, intent?.base);
      const observed = typeof adapter.workerObservation === 'function' ? adapter.workerObservation() : null;
      if (!intent || !['awaiting', 'parked'].includes(s.phase) || !request || !observed ||
          !Object.entries(request.binding).every(([k, value]) => observed[k] === value)) {
        result = { move: 'wait', reason: 'worker-observation-rejected' }; break;
      }
      if (observed.status === 'harness-unavailable' && intent.workerStage === 'claimed') {
        s.phase = 'parked'; result = { move: 'wait', reason: 'harness-unavailable' }; break;
      }
      if (observed.status === 'spawned' && intent.workerStage === 'claimed') {
        intent.workerStage = 'spawned'; intent.paneId = observed.paneId;
        result = { move: 'wait', reason: 'worker-spawned' }; break;
      }
      if (observed.status === 'submitted' && intent.workerStage === 'prompt-claimed') {
        intent.workerStage = 'submitted'; intent.deliveryId = observed.deliveryId;
        s.phase = 'awaiting'; result = { move: 'wait', reason: 'worker-submitted' }; break;
      }
      if (observed.status === 'answered' && intent.workerStage === 'submitted' && observed.deliveryId === intent.deliveryId) {
        intent.deliveryAcknowledged = true; result = { move: 'wait', reason: 'delivery-acknowledged' }; break;
      }
      s.phase = 'parked'; result = { move: 'wait', reason: 'effect-unknown' }; break;
    }
    case '_prompt': {
      if (!s.intent || !['awaiting', 'parked'].includes(s.phase) || s.intent.epoch !== s.epoch ||
          s.intent.writerId !== s.writerId || s.intent.workerStage !== 'spawned') {
        result = { move: 'wait', reason: 'prompt-unavailable' }; break;
      }
      s.intent.workerStage = 'prompt-claimed';
      result = { move: 'submit', intent: structuredClone(s.intent) }; break;
    }
    case 'procedure': {
      if (!['awaiting', 'parked'].includes(s.phase)) { result = { move: 'wait', reason: 'procedure-rejected' }; break; }
      const request = procedureRequest(w, s, git(w.repo, 'rev-parse', 'HEAD'));
      let observed;
      try { observed = request ? (adapter.observeProcedure ?? observeProcedure)(structuredClone(request)) : null; }
      catch { observed = null; }
      if (!matchingProcedure(request, observed, s.consumedProcedure ?? {})) {
        result = { move: 'wait', reason: 'procedure-rejected' }; break;
      }
      s.consumedProcedure ??= {};
      s.consumedProcedure[observed.evidenceId] = true;
      s.procedureEvidence = structuredClone(observed);
      result = { move: 'wait', reason: 'host-procedure-verified' }; break;
    }
    case 'receipt': {
      if (s.phase === 'cancelled') { result = { move: 'wait', reason: 'late-receipt-fenced' }; break; }
      if (!['awaiting', 'parked'].includes(s.phase) || !s.intent || !verifyReceipt(w, s, event.receipt)) { result = { move: 'wait', reason: 'receipt-rejected' }; break; }
      s.pending = { commit: event.receipt.commit, stepId: event.receipt.stepId, epoch: s.epoch,
        writerId: s.intent.writerId, dispatchId: s.intent.dispatchId, stepBaseHead: s.intent.base,
        ...(exitRequired(w, s) ? { outputs: recordOutputs(w.repo, event.receipt.commit, [w.steps[s.step].artifact]) } : {}) };
      s.intent.ack = true; s.phase = 'awaiting';
      result = { move: 'wait', reason: 'verified-receipt' };
      break;
    }
    case 'wake': {
      if (!id.test(event.transitionId ?? '') || !verifyWake(w, s, event)) { result = { move: 'wait', reason: 'wake-rejected' }; break; }
      if (s.phase === 'parked' && s.history.some(h => h.transitionId === event.transitionId)) { result = { move: 'wait', reason: 'wake-duplicate' }; break; }
      if (s.phase !== 'parked') { result = { move: 'wait', reason: 'wake-not-parked' }; break; }
      s.wake = event.transitionId;
      result = { move: 'wait', reason: 'verified-wake-recorded' };
      break;
    }
    case 'ack': {
      if (!s.intent || !['awaiting', 'parked'].includes(s.phase) ||
          event.dispatchId !== s.intent.dispatchId || event.epoch !== s.intent.epoch ||
          event.writerId !== s.intent.writerId || s.epoch !== s.intent.epoch) {
        result = { move: 'wait', reason: 'ack-rejected' }; break;
      }
      const observed = typeof adapter.acknowledge === 'function' ? adapter.acknowledge({ ...s.intent }) : null;
      if (!observed || observed.dispatchId !== s.intent.dispatchId ||
          observed.epoch !== s.intent.epoch || observed.writerId !== s.intent.writerId) {
        result = { move: 'wait', reason: 'ack-unverified' }; break;
      }
      // A trusted adapter acknowledges the issued effect, not worker procedure compliance.
      s.intent.ack = true; s.intent.deliveryAcknowledged = true;
      result = { move: 'wait', reason: 'dispatch-acknowledged' }; break;
    }
    case 'resume': {
      if (!s.intent || ['cancelled', 'held', 'done', 'exhausted'].includes(s.phase)) {
        result = { move: 'settled', reason: s.phase }; break;
      }
      const known = s.intent.ack && s.intent.epoch === s.epoch && s.intent.writerId === s.writerId;
      s.phase = known ? 'awaiting' : 'parked';
      result = { move: 'wait', reason: known ? 'acknowledged-dispatch' : 'readback-required' }; break;
    }
    case 'readback': {
      if (staleOwnershipIntent(s)) { result = { move: 'wait', reason: 'old-effect-reconciliation-required' }; break; }
      if (s.phase !== 'parked' || !s.intent) { result = { move: 'wait', reason: 'readback-not-parked' }; break; }
      if (event.status === 'unknown') { result = { move: 'wait', reason: 'readback-unknown' }; break; }
      const intent = s.intent;
      const observed = typeof adapter.readback === 'function' ? adapter.readback({ ...intent }) : null;
      if (!observed || observed.dispatchId !== intent.dispatchId || observed.epoch !== intent.epoch ||
          observed.writerId !== intent.writerId || observed.branch !== intent.branch ||
          !['absent', 'present'].includes(observed.status)) {
        result = { move: 'wait', reason: 'readback-unverified' }; break;
      }
      if (observed.status === 'absent' && !intent.ack && !intent.workerStage) {
        s.intent = null; s.pending = null; s.wake = null; s.phase = 'ready';
        result = { move: 'wait', reason: 'effect-confirmed-absent' }; break;
      }
      if (observed.status === 'present' && intent.epoch === s.epoch && intent.writerId === s.writerId) {
        s.intent.ack = true; s.phase = 'awaiting';
        result = { move: 'wait', reason: 'effect-confirmed-present' }; break;
      }
      result = { move: 'wait', reason: 'effect-fenced' }; break;
    }
    case 'hint': result = { move: 'wait', reason: 'hint-observed' }; break;
    case 'hold':
    case 'cancel':
      if (['done', 'held', 'cancelled', 'exhausted'].includes(s.phase)) { result = { move: 'settled', reason: s.phase }; break; }
      s.epoch++; s.phase = event.type === 'hold' ? 'held' : 'cancelled'; s.pending = null; s.wake = null;
      result = { move: 'settled', reason: event.type === 'hold' ? 'handbrake' : 'cancelled' }; break;
    case 'look': s.looks++; result = { move: 'wait', reason: 'observed' }; break;
    default: fail('unknown event');
  }
  s.seen[key] = signature;
  const response = { ...result, phase: s.phase, step: s.step, epoch: s.epoch,
    attempts: s.attempts[s.step] ?? s.attempts.at(-1) ?? 0, looks: s.looks,
    procedureDeclared: true, procedureVerified: result.procedureVerified ?? procedureVerified(w, s),
    deliveryAcknowledged: s.intent?.deliveryAcknowledged === true, authorityCreated: false };
  if (event.type === '_spec' && adapter.specEventId && result.reason !== 'spec-observation-rejected') {
    s.specResults ??= {}; s.specResults[adapter.specEventId] = response;
  }
  if (event.type === '_checks' && adapter.checksEventId && result.reason !== 'checks-observation-rejected') { s.checksResults ??= {}; s.checksResults[adapter.checksEventId] = response; }
  s.history.push({ id: key, type: event.type, result: response, phase: s.phase, step: s.step, epoch: s.epoch, ...(event.type === 'wake' && result.reason === 'verified-wake-recorded' ? { transitionId: event.transitionId } : {}) });
  // Reserve five records for an already issued final intent: wake, wake tick,
  // receipt, DONE tick, or one owner stop. Invalid/repeated evidence cannot
  // spend that reserve, and no new effect may start beyond the ordinary cap.
  const finalIntent = previous.step === w.steps.length - 1 && previous.intent;
  const terminalProgress = finalIntent && (
    (event.type === 'receipt' && !previous.pending && result.reason === 'verified-receipt') ||
    (event.type === 'wake' && !previous.wake && result.reason === 'verified-wake-recorded' &&
      !previous.history.some(h => h.type === 'wake' && h.step === previous.step && h.epoch === previous.epoch && h.result.reason === 'verified-wake-recorded')) ||
    (event.type === 'tick' && (result.phase === 'done' || result.reason === 'verified-wake')));
  if (s.history.length > 1024 && !terminalProgress && !['cancel', 'hold'].includes(event.type)) fail('run history limit');
  if (s.history.length > 1029) fail('run history reserve limit');
  return { state: s, result: response, duplicate: false };
}

function replaceDurably(store, name, contents) {
  const temp = join(store, `${name}.${randomUUID()}.new`);
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, join(store, name));
  const dir = openSync(store, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}

// The checkpoint is HMAC-bound to the exact journal prefix. A damaged or
// truncated prefix cannot be hidden by a replaceable state.json snapshot.
function replayJournal(store, workflow, key) {
  const file = join(store, 'journal.jsonl'), checkpoint = join(store, 'checkpoint.json');
  if (!existsSync(file)) {
    if (existsSync(checkpoint)) fail('journal missing; reconciliation required');
    return { state: initial(workflow), prev: '' };
  }
  const bytes = Buffer.from(readSafe(file));
  if (bytes.length && bytes.at(-1) !== 10) fail('torn journal tail requires reconciliation');
  let state = initial(workflow), prev = '', offset = 0;
  if (existsSync(checkpoint)) {
    let recorded;
    try { recorded = JSON.parse(readSafe(checkpoint)); } catch { fail('checkpoint integrity failure'); }
    const { checksum, ...body } = recorded;
    if (!Number.isSafeInteger(body.offset) || body.offset < 0 || body.offset > bytes.length ||
        body.prefixHash !== sha(bytes.subarray(0, body.offset)) || checksum !== seal(key, body) ||
        body.state?.contractDigest !== state.contractDigest || !Array.isArray(body.state?.history) ||
        !body.state?.seen || typeof body.state.seen !== 'object') fail('checkpoint integrity failure');
    state = body.state; prev = body.prev; offset = body.offset;
  }
  for (const line of bytes.subarray(offset).toString('utf8').split('\n').filter(Boolean)) {
    let record;
    try { record = JSON.parse(line); } catch { fail('journal integrity failure'); }
    const { checksum, ...body } = record;
    if (body.prev !== prev || checksum !== seal(key, body) || !body.event?.id ||
        !body.result || typeof body.state?.contractDigest !== 'string' ||
        !Array.isArray(body.state?.history) || body.state.history.at(-1)?.id !== body.event.id ||
        canonical(body.state.history.at(-1)?.result) !== canonical(body.result)) fail('journal integrity failure');
    if (body.state.contractDigest !== state.contractDigest) fail('workflow revision mismatch');
    if (body.state.seen) {
      // Previously committed full-state records are still readable.
      if (body.state.history.length !== state.history.length + 1) fail('journal transition mismatch');
      state = body.state;
    } else {
      if (body.state.history.length !== 1 || state.seen[body.event.id]) fail('journal transition mismatch');
      const { history, ...fields } = body.state;
      Object.assign(state, fields);
      state.history.push(history[0]);
      state.seen[body.event.id] = sha(canonical(body.event));
    }
    prev = checksum;
  }
  return { state, prev };
}

function persist(store, output, event, prev, key) {
  const { history, seen, ...fields } = output.state;
  const body = { event, state: { ...fields, history: [history.at(-1)] }, result: output.result, prev };
  const checksum = seal(key, body);
  const file = join(store, 'journal.jsonl');
  const journal = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(journal, JSON.stringify({ ...body, checksum }) + '\n'); fsyncSync(journal); } finally { closeSync(journal); }
  // One full authenticated checkpoint per 32 deltas bounds replay work. The
  // human-readable state projection is not authoritative and is updated only
  // on phase/effect changes or checkpoint ticks, not every look poll.
  if (history.length % 32 === 0) {
    const bytes = Buffer.from(readSafe(file));
    const snapshot = { offset: bytes.length, prefixHash: sha(bytes), state: output.state, prev: checksum };
    replaceDurably(store, 'checkpoint.json', JSON.stringify({ ...snapshot, checksum: seal(key, snapshot) }) + '\n');
  }
  if (history.length === 1 || history.length % 32 === 0 || output.result.move === 'act' ||
      ['cancel', 'hold', 'procedure', 'dispatch', '_worker', '_prompt'].includes(event.type) || ['advance', 'settled'].includes(output.result.move))
    replaceDurably(store, 'state.json', JSON.stringify(output.state) + '\n');
}

// Read-only projection: never trusts the replaceable snapshot over the append-only journal.
export function readStatus(w, store) {
  const workflow = validateWorkflow(w);
  const root = join(workflow.repo, '.local', 'workflow-runner');
  const target = resolve(store);
  if (dirname(target) !== root || !id.test(target.slice(root.length + 1)) || !existsSync(target) || realpathSync(target) !== target) fail('invalid workflow status store');
  const marker = join(target, 'halt.json');
  if (existsSync(marker)) return { phase: 'held', reason: 'journal-reconciliation-required', authorityCreated: false };
  const digestId = workflowIdentity(workflow);
  const binding = join(root, '.contracts', digestId);
  if (readSafe(binding) !== target) fail('workflow task binding mismatch');
  const key = readSafe(join(root, '.keys', digestId));
  if (!digest.test(key)) fail('workflow journal key invalid');
  const { state } = replayJournal(target, workflow, key);
  return { phase: state.phase, step: state.step, epoch: state.epoch, attempts: state.attempts,
    looks: state.looks, intent: state.intent, pending: state.pending, ownership: ownershipOf(state),
    writerId: state.writerId, contractDigest: state.contractDigest, spec: state.spec ?? null, exit: state.exit ?? null,
    specResults: state.specResults ?? {}, checksResults: state.checksResults ?? {}, exitClaim: state.exitClaim ?? null, authorityCreated: false };
}

// Generation files are immutable. The kernel arbitrates each next name via link;
// no contender renames or unlinks a live lock while inspecting a predecessor.
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const writerToken = /^(\d+):([0-9a-f-]{36})$/;

function lockSummary(target, key) {
  const file = join(target, 'lock-summary.json');
  if (!existsSync(file)) return { retired: [] };
  let record;
  try { record = JSON.parse(readSafe(file)); } catch { fail('lock summary integrity failure'); }
  const { checksum, ...body } = record;
  if (checksum !== seal(key, body) || !Array.isArray(body.retired) ||
      body.retired.some((entry, index) => !Number.isSafeInteger(entry.generation) ||
        entry.generation < 1 || !writerToken.test(entry.token) ||
        (index > 0 && entry.generation <= body.retired[index - 1].generation)))
    fail('lock summary integrity failure');
  return body;
}

// Exact retired generation/token facts are sealed before old completed links
// are removed. The newest two generations stay on disk for concurrent readers.
function compactCompleted(target, key, adapter) {
  const generations = readdirSync(target).map(name => /^writer\.g\.(\d+)\.lock$/.exec(name))
    .filter(Boolean).map(match => Number(match[1])).filter(Number.isSafeInteger).sort((a, b) => a - b);
  const summary = lockSummary(target, key);
  if (generations.length <= 12) return;
  let proposal;
  try { proposal = adapter.decisionsApi?.proposeCompaction?.({ completedGenerations: generations.length }); }
  catch { proposal = undefined; } // Optional scheduling advice cannot wedge writer completion.
  // A Decisions API may schedule early maintenance; it never chooses facts or
  // vetoes the hard bound. No external service or credential is required.
  if (proposal?.compact === false && generations.length <= 16) return;
  const retired = new Map(summary.retired.map(entry => [entry.generation, entry.token]));
  const remove = [];
  for (const generation of generations.slice(0, -2)) {
    const lock = join(target, `writer.g.${generation}.lock`);
    const done = join(target, `writer.g.${generation}.done`);
    const token = readSafe(lock);
    if (!writerToken.test(token)) fail('runner writer lock needs reconciliation');
    if (existsSync(done) && (!sameIdentity(lstatSync(lock), lstatSync(done)) || readSafe(done) !== token))
      fail('runner writer lock completion mismatch; reconciliation required');
    if (!existsSync(done) && retired.get(generation) !== token) continue;
    if (retired.has(generation) && retired.get(generation) !== token) fail('lock summary integrity failure');
    retired.set(generation, token);
    remove.push({ lock, done });
  }
  const facts = { retired: [...retired].sort(([a], [b]) => a - b).map(([generation, token]) => ({ generation, token })) };
  replaceDurably(target, 'lock-summary.json', JSON.stringify({ ...facts, checksum: seal(key, facts) }) + '\n');
  for (const { lock, done } of remove) {
    if (existsSync(done)) unlinkSync(done);
    unlinkSync(lock);
  }
  const dir = openSync(target, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
function publishWriter(target, generation) {
  const lock = join(target, `writer.g.${generation}.lock`);
  const candidate = join(target, `writer.claim.${randomUUID()}`);
  const ownerToken = `${process.pid}:${randomUUID()}`;
  const fd = openSync(candidate, 'wx', 0o600);
  try {
    writeFileSync(fd, ownerToken); fsyncSync(fd);
    try { linkSync(candidate, lock); }
    catch (error) { if (error.code === 'EEXIST') { closeSync(fd); return null; } throw error; }
    return { fd, ownerToken, lock, done: join(target, `writer.g.${generation}.done`) };
  } catch (error) { if (error.code !== 'EEXIST') closeSync(fd); throw error; }
  finally { unlinkSync(candidate); }
}
function observeOwner(path, label) {
  let token, observed;
  try { token = readSafe(path); observed = lstatSync(path); }
  catch { fail(`runner ${label} unreadable; reconciliation required`); }
  const owner = writerToken.exec(token);
  if (!owner || !observed.isFile()) fail(`runner ${label} needs reconciliation`);
  return { path, token, observed, pid: Number(owner[1]) };
}
function requireDead(owner, label) {
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) fail(`runner ${label} needs reconciliation`);
  try { process.kill(owner.pid, 0); fail(`runner ${label} already in progress`); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code === 'EPERM') fail(`runner ${label} permission uncertain; reconciliation required`);
    throw error;
  }
}
function unchangedOwner(owner, label) {
  try {
    if (readSafe(owner.path) === owner.token && sameIdentity(lstatSync(owner.path), owner.observed)) return;
  } catch { /* disappearance is not proof of safe retirement */ }
  fail(`runner ${label} changed; do not replay`);
}
function acquireWriterLock(target, pause = () => {}) {
  const generations = readdirSync(target).map(name => /^writer\.g\.(\d+)\.lock$/.exec(name))
    .filter(Boolean).map(match => Number(match[1])).filter(Number.isSafeInteger);
  const latest = generations.length ? Math.max(...generations) : 0;
  const current = latest ? join(target, `writer.g.${latest}.lock`) : null;
  const legacy = join(target, 'writer.lock');
  const legacyDone = join(target, 'writer.legacy.done');
  const unretiredLegacy = existsSync(legacy) && (!existsSync(legacyDone) ||
    !sameIdentity(lstatSync(legacy), lstatSync(legacyDone)));
  const currentDone = latest ? join(target, `writer.g.${latest}.done`) : null;
  const currentActive = current && !existsSync(currentDone);
  // A published generation still in flight takes priority over a legacy lock.
  const previous = currentActive ? current : unretiredLegacy ? legacy : current;
  const done = previous === legacy ? legacyDone : currentDone;
  if (previous) {
    const owner = observeOwner(previous, 'writer lock');
    if (existsSync(done)) {
      if (!sameIdentity(lstatSync(done), owner.observed) || readSafe(done) !== owner.token)
        fail('runner writer lock completion mismatch; reconciliation required');
    } else {
      const guard = join(target, 'writer-recovery');
      let guardOwner = null;
      if (existsSync(guard)) {
        guardOwner = observeOwner(guard, 'recovery guard');
        requireDead(guardOwner, 'recovery guard');
        pause('guard');
      }
      requireDead(owner, 'writer lock');
      pause('lock');
      // Independent checks: neither replacing the predecessor inode nor
      // changing the recovery guard may authorize a successor.
      unchangedOwner(owner, 'writer lock');
      pause('pre-publish');
      unchangedOwner(owner, 'writer lock');
      if (guardOwner) unchangedOwner(guardOwner, 'recovery guard');
      if (previous === legacy) {
        try { linkSync(legacy, legacyDone); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (!sameIdentity(lstatSync(legacyDone), owner.observed)) fail('runner writer legacy completion mismatch');
      }
    }
  }
  const next = publishWriter(target, latest + 1);
  if (!next) fail('runner writer acquired by another process; do not replay');
  // Compaction keeps the newest generations, so a higher name proves this one was
  // retired and re-created from a stale view. Withdraw it rather than run beside it.
  if (readdirSync(target).some(name => Number(/^writer\.g\.(\d+)\.lock$/.exec(name)?.[1]) > latest + 1)) {
    try { if (sameIdentity(lstatSync(next.lock), fstatSync(next.fd))) unlinkSync(next.lock); } finally { closeSync(next.fd); }
    fail('runner writer acquired by another process; do not replay');
  }
  return next;
}

function emergencyHalt(target, event, error) {
  if (!['cancel', 'hold'].includes(event?.type) || !existsSync(target) ||
      realpathSync(target) !== target || !/binding|index|contract|key|lock|guard|journal|checkpoint|reconcil|ENOENT.*keys/i.test(error.message)) throw error;
  const marker = join(target, 'halt.json');
  try {
    const fd = openSync(marker, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ reason: event.type, note: 'journal-reconciliation-required' })); fsyncSync(fd); }
    finally { closeSync(fd); }
    const dir = openSync(target, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
  return { move: 'settled', reason: JSON.parse(readSafe(marker)).reason,
    reconciliationRequired: true, authorityCreated: false };
}

export function run(w, store, event, adapter = {}) {
  const workflow = validateWorkflow(w), target = resolve(store);
  const root = join(workflow.repo, '.local', 'workflow-runner');
  if (dirname(target) !== root || !id.test(target.slice(root.length + 1))) fail('invalid authority store');
  if (existsSync(target) && realpathSync(target) !== target) fail('private store must not escape through symlink');
  for (const identity of workflowIdentities(workflow)) {
    const binding = join(root, '.contracts', identity);
    if (existsSync(binding) && readSafe(binding) !== target) fail('workflow already bound to a different task run');
  }
  const gate = authorityGate(adapter.authority, target, workflow.repo);
  return gate.start(event, () => runCache(workflow, target, event, { ...adapter, authorityBeforePersist: gate.beforePersist }));
}

export function readAuthorizedStatus(w, store, authority) {
  const workflow = validateWorkflow(w), target = resolve(store);
  const root = join(workflow.repo, '.local', 'workflow-runner');
  if (dirname(target) !== root || !id.test(target.slice(root.length + 1))) fail('invalid authority store');
  return authorityGate(authority, target, workflow.repo).start({ type: 'status' }, () => readStatus(workflow, target));
}

function runCache(workflow, store, event, adapter = {}) {
  const privateRoot = join(workflow.repo, '.local', 'workflow-runner');
  const target = resolve(store);
  if (dirname(target) !== privateRoot || !id.test(target.slice(privateRoot.length + 1))) fail('store must be one task under owning repository .local/workflow-runner');
  try {
  if (existsSync(target) && realpathSync(target) !== target) fail('private store must not escape through symlink');
  if (existsSync(join(target, 'halt.json'))) return { move: 'settled', reason: JSON.parse(readSafe(join(target, 'halt.json'))).reason, authorityCreated: false };
  const local = join(workflow.repo, '.local');
  mkdirSync(local, { recursive: true });
  if (realpathSync(local) !== local) fail('private store must not escape through symlink');
  mkdirSync(privateRoot, { recursive: true });
  if (realpathSync(privateRoot) !== privateRoot) fail('private store must not escape through symlink');
  // Old digest-and-whole-list indexes cannot be reverse-mapped to per-step
  // tombstones. Refuse migration rather than silently restoring their budget.
  const identityScheme = join(privateRoot, '.identity-v2');
  if (!existsSync(identityScheme)) {
    for (const name of ['.contracts', '.keys']) {
      const old = join(privateRoot, name);
      if (existsSync(old) && readdirSync(old).length) fail('legacy workflow binding requires reconciliation');
    }
    try {
      const fd = openSync(identityScheme, 'wx', 0o600);
      try { writeFileSync(fd, 'per-step-v2\n'); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (readSafe(identityScheme) !== 'per-step-v2\n') fail('workflow identity scheme requires reconciliation');
  const identities = workflowIdentities(workflow);
  const digestId = identities[0];
  for (const identity of identities) {
    const boundPath = join(privateRoot, '.contracts', identity);
    if (!existsSync(boundPath) && existsSync(join(privateRoot, '.keys', identity)))
      fail('workflow task binding missing; reconciliation required');
    if (existsSync(boundPath) && readSafe(boundPath) !== target) fail('workflow already bound to a different task run');
  }
  mkdirSync(target, { recursive: true });
  if (realpathSync(target) !== target) fail('private store must not escape through symlink');
  const bindings = join(privateRoot, '.contracts'); mkdirSync(bindings, { recursive: true });
  if (realpathSync(bindings) !== bindings) fail('private index must not escape through symlink');
  const keys = join(privateRoot, '.keys'); mkdirSync(keys, { recursive: true });
  if (realpathSync(keys) !== keys) fail('private key store must not escape through symlink');
  const binding = join(bindings, digestId), keyPath = join(keys, digestId);
  // The key survives index loss: a missing binding must never mint a new budget.
  if (!existsSync(binding) && existsSync(keyPath)) fail('workflow task binding missing; reconciliation required');
  let newBinding = false;
  for (const identity of identities) {
    const path = join(bindings, identity);
    try {
      const index = openSync(path, 'wx', 0o600);
      if (path === binding) newBinding = true;
      try { writeFileSync(index, target); fsyncSync(index); } finally { closeSync(index); }
    } catch (error) {
      if (error.code !== 'EEXIST' || readSafe(path) !== target) fail('workflow already bound to a different task run');
    }
  }
  if (newBinding) {
    const secret = openSync(keyPath, 'wx', 0o600);
    try { writeFileSync(secret, randomBytes(32).toString('hex')); fsyncSync(secret); } finally { closeSync(secret); }
    const dir = openSync(keys, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  const key = readSafe(keyPath);
  if (!digest.test(key)) fail('workflow journal key invalid');
  lockSummary(target, key);
  if (existsSync(join(target, 'journal.jsonl'))) {
    const cached = replayJournal(target, workflow, key).state;
    if (cached.seen[event?.id]) {
      if (cached.seen[event.id] !== sha(canonical(event))) fail('event-id conflict');
      const original = cached.history.find(entry => entry.id === event.id)?.result;
      if (!original) fail('missing original event result');
      const fastHalt = join(target, 'halt.json');
      if (existsSync(fastHalt)) return { move: 'settled', reason: JSON.parse(readSafe(fastHalt)).reason, authorityCreated: false };
      return ['cancelled', 'held'].includes(cached.phase)
        ? { move: 'settled', reason: cached.phase, authorityCreated: false, duplicate: true }
        : ownershipReplay(cached, original) ?? (original.move === 'act'
          ? { move: 'wait', phase: 'parked', reason: 'UNKNOWN_EFFECT_PENDING', duplicate: true, authorityCreated: false }
          : { ...original, duplicate: true });
    }
    if (cached.history.length >= 1024 && !['cancel', 'hold', 'receipt', 'wake', 'tick'].includes(event?.type)) fail('run history limit');
  }
  const { fd, ownerToken, lock, done } = acquireWriterLock(target,
    typeof adapter.onRecoveryPause === 'function' ? adapter.onRecoveryPause : undefined);
  return retainWriter(() => {
    const marker = join(target, 'halt.json');
    if (existsSync(marker)) return { move: 'settled', reason: JSON.parse(readSafe(marker)).reason, authorityCreated: false };
    const { state, prev } = replayJournal(target, workflow, key);
    const output = transition(workflow, state, event, { ...adapter, handoverConsumed: exit => returnHandoverConsumed(workflow.repo, exit), taskId: target.slice(privateRoot.length + 1) });
    if (['act', 'spawn', 'submit'].includes(output.result.move)) {
      if (typeof adapter.onBeforePublish === 'function') adapter.onBeforePublish();
      // Cancel may land while transition is computing. Never publish a dispatch
      // or its journal record after the durable owner halt is visible.
      if (existsSync(marker)) return { move: 'settled', reason: JSON.parse(readSafe(marker)).reason, authorityCreated: false };
    }
    if (output.result.procedureVerified && existsSync(marker))
      return { move: 'settled', reason: JSON.parse(readSafe(marker)).reason, authorityCreated: false };
    return thenResult(adapter.authorityBeforePersist(output, state), blocked => {
    if (blocked) return blocked;
    if (existsSync(marker)) return { move: 'settled', reason: JSON.parse(readSafe(marker)).reason, authorityCreated: false };
    if (!output.duplicate) {
      persist(target, output, event, prev, key);
      // Discovery metadata is not authority: native consumers authenticate it
      // against the journal contract before resolving any current check claim.
      if (!existsSync(join(target, 'workflow.json'))) replaceDurably(target, 'workflow.json', canonical(workflow));
    }
    if (output.result.procedureVerified && existsSync(marker))
      return { move: 'settled', reason: JSON.parse(readSafe(marker)).reason, authorityCreated: false };
    if (['act', 'spawn', 'submit'].includes(output.result.move)) {
      if (typeof adapter.onAfterPersist === 'function') adapter.onAfterPersist();
      // Even if an owner stop arrived during journal fsync, never hand that
      // old decision to a caller as a new worker dispatch.
      if (existsSync(marker)) return { move: 'settled', reason: JSON.parse(readSafe(marker)).reason, authorityCreated: false };
    }
    return output.result;
    });
  }, () => {
    try {
      if (sameIdentity(lstatSync(lock), fstatSync(fd)) && readSafe(lock) === ownerToken) {
        compactCompleted(target, key, adapter);
        linkSync(lock, done);
        const dir = openSync(target, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      }
    } catch { /* an uncertain completion remains fenced, never replayed blindly */ }
    closeSync(fd);
  });
  } catch (error) { return emergencyHalt(target, event, error); }
}
