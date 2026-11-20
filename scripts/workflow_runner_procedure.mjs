// Host-only procedure observation. Workers cannot choose executables or argv.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(JSON.stringify(value));
const hex = /^[a-f0-9]{64}$/;
const id = /^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/;
const CHECK = 'git-diff-check.v1';

export function validProcedure(requirement) {
  return requirement?.schema === 'pad-procedure.v1' &&
    Object.keys(requirement).every(k => ['schema', 'checks'].includes(k)) &&
    Array.isArray(requirement.checks) && requirement.checks.length === 1 && requirement.checks[0] === CHECK;
}

export function procedureRequest(w, state, commit) {
  const step = w.steps[state.step], intent = state.intent;
  if (!validProcedure(step?.procedure) || !intent || !id.test(intent.taskId ?? '') ||
      intent.epoch !== state.epoch || intent.writerId !== state.writerId ||
      intent.stepId !== step.id) return null;
  return { repo: w.repo, base: intent.base, commit, checks: [...step.procedure.checks], binding: {
    taskId: intent.taskId, stepId: step.id, epoch: state.epoch, writerId: state.writerId,
    dispatchId: intent.dispatchId, commit,
    inputDigest: digest({ contract: state.contractDigest, base: intent.base, branch: intent.branch, step: step.id, commit }),
    requirementDigest: digest(step.procedure),
  } };
}

export function observeProcedure(request) {
  // This is intentionally one closed check, not a shell/command registry API.
  // timeout/maxBuffer bound execution and captured output; errors never verify.
  const result = spawnSync('git', ['-C', request.repo, 'diff', '--no-ext-diff', '--no-textconv', '--check', request.base, request.commit], {
    encoding: 'buffer', timeout: 10000, maxBuffer: 65536, shell: false,
    env: { ...process.env, GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat' },
  });
  const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
  return { ...request.binding, evidenceId: `evidence-${randomUUID()}`,
    checks: [{ id: CHECK, exitStatus: result.error || result.signal ? null : result.status,
      outputDigest: sha(output) }] };
}

export function matchingProcedure(request, observed, consumed) {
  if (!request || !observed || !id.test(observed.evidenceId ?? '') || consumed[observed.evidenceId] ||
      !Object.entries(request.binding).every(([key, value]) => observed[key] === value)) return false;
  return Array.isArray(observed.checks) && observed.checks.length === request.checks.length &&
    observed.checks.every((check, index) => check.id === request.checks[index] &&
      check.exitStatus === 0 && hex.test(check.outputDigest ?? ''));
}
