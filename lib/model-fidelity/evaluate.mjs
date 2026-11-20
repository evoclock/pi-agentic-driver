import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { assessRedLines, validateRedLineConfig } from './red-lines.mjs';
import { validateRecord } from './records.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const error = (code, message) => Object.assign(new Error(message), { code });
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const finding = (code, message, extra = {}) => ({ id: `F-${code}-${Object.keys(extra).length}`, code, message, origin: 'author-claim', evidenceIds: [], ...extra });

function changedPaths(repoRoot, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw error('invalid-request', 'Invalid source revision');
  const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  const records = git(['diff', '--name-status', '--no-renames', '-z', revision, '--']).toString().split('\0');
  const diff = { modified: [], deleted: [], added: [] };
  for (let i = 0; i + 1 < records.length; i += 2) {
    const [status, name] = records.slice(i, i + 2);
    if (status === 'D') diff.deleted.push(name);
    else if (status === 'A') diff.added.push(name);
    else if (status === 'M' || status === 'T') diff.modified.push(name);
    else throw error('invalid-diff', `Unsupported diff status ${status}`);
  }
  for (const name of git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)) diff.added.push(name);
  return diff;
}

export async function evaluate(request, { claim, repoRoot, storeRoot, localFile, bounded, baseResult }) {
  const { planId, bundleId, assessmentIds, runtimeArtifactIds, changeRef, rollbackRecordRef, priorEvaluateRequestId } = request.payload;
  if (![planId, bundleId, ...assessmentIds, ...runtimeArtifactIds, ...(priorEvaluateRequestId ? [priorEvaluateRequestId] : [])].every(safeId)) throw error('invalid-request', 'Invalid evaluation ID');
  const planFile = await localFile(storeRoot, `units/${request.unitId}/plans/${planId}/original.json`);
  const planBytes = await bounded(planFile);
  const plan = JSON.parse(planBytes);
  if (!validateRecord('plan', plan).ok) throw error('invalid-plan', 'Frozen plan is invalid');
  const manifestFile = await localFile(claim.base, `input/bundles/${bundleId}/manifest.json`);
  const manifestBytes = await bounded(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.bundleId !== bundleId || manifest.unitId !== request.unitId || manifest.attemptId !== request.attemptId || manifest.owner !== claim.owner || manifest.generation !== claim.generation) throw error('bundle-conflict', 'Bundle ownership differs');
  const original = manifest.files[0];
  const captured = await bounded(await localFile(claim.base, `input/bundles/${bundleId}/files/${original.path}`));
  if (sha(captured) !== original.sha256 || sha(captured) !== sha(planBytes)) throw error('bundle-conflict', 'Frozen plan differs from captured bytes');
  for (const item of manifest.files) {
    const bytes = await bounded(await localFile(claim.base, `input/bundles/${bundleId}/files/${item.path}`));
    if (sha(bytes) !== item.sha256) throw error('bundle-conflict', 'Captured input changed');
  }
  const change = JSON.parse(await bounded(await localFile(repoRoot, changeRef)));
  if (!change || !Array.isArray(change.goals) || change.goals.some(goal => typeof goal !== 'string')) throw error('invalid-request', 'changeRef must contain a goals array');
  const diff = changedPaths(repoRoot, manifest.sourceRevision);
  const configRef = process.env.PAD_MF_RED_LINES;
  const config = configRef ? validateRedLineConfig(JSON.parse(await bounded(await localFile(repoRoot, configRef)))) : validateRedLineConfig({ schema: 'model-fidelity.red-lines.v1', rawDataPaths: [], keyAssetPaths: [] });
  const redLines = assessRedLines(diff, config);
  const result = baseResult(request);
  result.planId = planId;
  result.bundleId = bundleId;
  result.manifestDigest = sha(manifestBytes);
  result.revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  result.changedPaths = diff;
  result.planMatch = change.goals.length === plan.goals.length && change.goals.every((goal, i) => goal === plan.goals[i]) ? 'unknown' : 'differs';
  if (result.planMatch === 'differs') result.findings.push(finding('plan-differs', 'Built goals or acceptance wording differ from the frozen original plan.'));
  else result.findings.push(finding('plan-match-unproven', 'Matching goal wording does not prove built behavior.'));
  if (!configRef) result.findings.push(finding('red-line-config-missing', 'No host raw-data or key-asset lists were configured; evidence deletion is still checked.'));
  result.findings.push(...redLines.findings.map((item, index) => ({ id: `F-red-line-${index}`, code: item.redLine, message: `${item.path}: ${item.redLine}`, origin: 'inspected-source', evidenceIds: [], redLine: item.redLine, confidence: item.confidence })));
  result.continuation = redLines.continuation;
  result.stoppedActions = redLines.stoppedActions;
  for (const ref of [...assessmentIds, ...runtimeArtifactIds]) {
    const file = await localFile(claim.base, `results/${ref}.json`);
    const record = JSON.parse(await bounded(file));
    if (record.bundleId !== bundleId || record.unitId !== request.unitId || record.attemptId !== request.attemptId) throw error('bundle-conflict', 'Referenced result does not belong to the built bundle');
  }
  if (!runtimeArtifactIds.length) result.findings.push(finding('runtime-not-run', 'No runtime observation was supplied.'));
  // File contents supplied by a caller are not host-observed runtime evidence.
  else { result.runtime = 'unknown'; result.findings.push(finding('runtime-unverified', 'Caller-supplied runtime records do not establish host observation.')); }
  result.rollback = result.planMatch === 'differs' ? 'suggested' : 'not-needed';
  if (rollbackRecordRef !== null) {
    if (!priorEvaluateRequestId) throw error('invalid-request', 'Rollback requires a prior evaluate request ID');
    const prior = JSON.parse(await bounded(await localFile(claim.base, `results/${priorEvaluateRequestId}.json`)));
    if (prior.operation !== 'evaluate' || prior.bundleId !== bundleId || prior.planId !== planId || prior.unitId !== request.unitId || prior.attemptId !== request.attemptId || prior.rollbackRecordRef !== null) throw error('invalid-request', 'Rollback must cite the first evaluation of this bundle');
    const rollback = JSON.parse(await bounded(await localFile(repoRoot, rollbackRecordRef)));
    if (!validateRecord('caller-step', rollback).ok || rollback.kind !== 'rollback' || rollback.unitId !== request.unitId || rollback.attemptId !== request.attemptId) throw error('invalid-request', 'Invalid rollback record');
    if (rollback.revision !== result.revision || rollback.revision !== prior.revision || rollback.manifestDigest !== sha(manifestBytes) || prior.manifestDigest !== sha(manifestBytes)) {
      result.findings.push(finding('stale-rollback-target', 'Rollback clearance does not match the current revision and bundle manifest.'));
      result.rollback = 'unknown';
    } else {
      result.rollback = rollback.outcome === 'observed' ? 'unknown' : rollback.outcome;
      if (rollback.outcome === 'observed') result.findings.push(finding('rollback-unverified', 'A caller rollback claim does not establish host observation.'));
    }
  } else if (priorEvaluateRequestId) throw error('invalid-request', 'Prior evaluation is only used for the second rollback call');
  result.rollbackRecordRef = rollbackRecordRef;
  if (result.rollback === 'suggested') result.findings.push(finding('deprecate-before-removal', 'Deprecate wrong work and point to its replacement; never revert or delete key assets automatically.'));
  result.status = result.findings.length ? 'partial' : 'complete';
  result.artifactIds.push(`evaluation/${request.requestId}/result.json`);
  return result;
}
