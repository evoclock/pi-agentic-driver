import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateRecord } from './records.mjs';

const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });

async function captured(base, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw failure('invalid-reference', 'Invalid captured reference');
  let at = await realpath(base);
  for (const part of relative.split('/')) {
    at = path.join(at, part);
    if ((await lstat(at)).isSymbolicLink()) throw failure('invalid-reference', 'Symlink evidence refused');
  }
  const handle = await open(at, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024) throw failure('read-limit', 'Evidence exceeds the record limit');
    return await handle.readFile();
  } finally { await handle.close(); }
}

const finding = (code, message, evidenceIds = []) => ({ id: `assess-${code}-${sha(JSON.stringify([message, evidenceIds])).slice(0, 12)}`, code, message, origin: 'author-claim', evidenceIds });

/** Assess captured records. Only a host-supplied verifier may attest independent provenance; JSON cannot. */
export async function assess(request, claim, { verifyReview } = {}) {
  const { bundleId, reviewArtifactIds, checkResultIds } = request.payload;
  if (![bundleId, ...reviewArtifactIds, ...checkResultIds].every(safeId) || new Set(reviewArtifactIds).size !== reviewArtifactIds.length || new Set(checkResultIds).size !== checkResultIds.length) throw failure('invalid-request', 'Expected distinct safe evidence IDs');
  const manifestBytes = await captured(claim.base, `input/bundles/${bundleId}/manifest.json`);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.bundleId !== bundleId || manifest.unitId !== request.unitId || manifest.attemptId !== request.attemptId || manifest.owner !== claim.owner || manifest.generation !== claim.generation) throw failure('bundle-conflict', 'Bundle is not owned by this attempt');
  const findings = [];
  const reviews = [];
  const checks = [];
  for (const resultId of checkResultIds) {
    let check;
    try { check = JSON.parse(await captured(claim.base, `results/${resultId}.json`)); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      findings.push(finding('missing-check', `Check result ${resultId} is not captured.`));
      continue;
    }
    if (check.operation !== 'check' || check.requestId !== resultId || check.bundleId !== bundleId || check.unitId !== request.unitId || check.attemptId !== request.attemptId) {
      findings.push(finding('stale-check', `Check result ${resultId} does not bind this bundle.`, [`results/${resultId}.json`]));
      continue;
    }
    checks.push(...check.checks);
  }
  if (!checkResultIds.length) findings.push(finding('missing-check', 'No model-check result was supplied.'));
  for (const reviewId of reviewArtifactIds) {
    const ref = `reviews/${reviewId}.json`;
    let bytes;
    try { bytes = await captured(claim.base, ref); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      findings.push(finding('missing-review', `Review ${reviewId} is not captured in this attempt.`));
      continue;
    }
    let review;
    try { review = JSON.parse(bytes); }
    catch { findings.push(finding('invalid-review', `Review ${reviewId} is not valid JSON.`, [ref])); continue; }
    if (!validateRecord('review', review).ok || review.id !== reviewId) { findings.push(finding('invalid-review', `Review ${reviewId} is not a v1 review.`, [ref])); continue; }
    if (review.bundleId !== bundleId) { findings.push(finding('stale-review', `Review ${reviewId} cites another bundle.`, [ref])); continue; }
    // The CLI never upgrades a caller's provenance label into independent review.
    const independent = review.provenance === 'host-bound' && typeof verifyReview === 'function' && await verifyReview({ review, bytes, manifestDigest: sha(manifestBytes), reference: ref }) === true && review.reviewer !== claim.owner;
    if (!independent) findings.push(finding(review.reviewer === claim.owner ? 'author-review' : 'self-reported-review', `Review ${reviewId} has no independently bound host provenance.`, [ref]));
    if (!review.challengeSchedules.length) findings.push(finding('unknown-schedules', `Review ${reviewId} names no challenge schedules.`, [ref]));
    if (!review.evidenceIds.length) findings.push(finding('missing-enforcing-evidence', `Review ${reviewId} cites no enforcing operation evidence. A mechanism name is not proof.`, [ref]));
    for (const assumption of review.unresolvedAssumptions) findings.push(finding('unresolved-assumption', assumption, [ref]));
    reviews.push({ id: reviewId, reference: ref, provenance: independent ? 'host-bound' : 'self-reported', schedules: review.challengeSchedules, assumptions: review.unresolvedAssumptions });
  }
  if (!reviewArtifactIds.length) findings.push(finding('missing-review', 'No review artifact was supplied.'));
  const supported = reviews.length > 0 && reviews.every(review => review.provenance === 'host-bound') && checks.length > 0 && findings.length === 0;
  return {
    schema: 'model-fidelity.result.v1', requestId: request.requestId, unitId: request.unitId, attemptId: request.attemptId,
    operation: 'assess', bundleId, status: findings.length ? 'partial' : 'complete', continuation: 'continue', findings, checks,
    correspondence: supported ? 'supported-under-assumptions' : reviews.length ? 'gaps' : 'not-assessed',
    reviews, outstandingAssumptions: reviews.flatMap(review => review.assumptions), attemptedFaultSchedules: reviews.flatMap(review => review.schedules),
    runtime: 'not-run', diagrams: [], artifactIds: [], errors: [], authorityCreated: false,
  };
}
