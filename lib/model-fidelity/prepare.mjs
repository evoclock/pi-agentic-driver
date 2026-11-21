import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createAttempt, captureBundle, publishOutput } from './attempts.mjs';
import { validateRecord } from './records.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const fail = (code, message) => Object.assign(new Error(message), { code });

async function input(repo, ref) {
  if (typeof ref !== 'string' || !ref || path.isAbsolute(ref) || ref.includes('\\') || ref.split('/').some(p => !p || p === '.' || p === '..')) throw fail('invalid-reference', 'Expected a repository-relative file');
  let target = await realpath(repo);
  for (const part of ref.split('/')) {
    target = path.join(target, part);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw fail('invalid-reference', 'Symlink inputs are not permitted');
  }
  if (!(await lstat(target)).isFile()) throw fail('invalid-reference', 'Expected a file');
  return readFile(target);
}

async function original(storeRoot, unitId, planId) {
  const root = await realpath(storeRoot);
  const file = path.join(root, 'units', unitId, 'plans', planId, 'original.json');
  const relative = path.relative(root, file);
  let at = root;
  for (const part of relative.split(path.sep)) {
    at = path.join(at, part);
    if ((await lstat(at)).isSymbolicLink()) throw fail('invalid-store', 'Symlink in plan store');
  }
  return readFile(file);
}

function finding(code, message, actionId) {
  return { id: `F${code.replaceAll(/[^a-zA-Z0-9]/g, '')}${actionId ? `-${actionId}` : ''}`, code, message, ...(actionId ? { actionId } : {}), origin: 'author-claim', evidenceIds: [] };
}

async function inventory(repoRoot, mode, planRecordId, designRefs) {
  const findings = [];
  const refs = new Set(designRefs);
  if (!designRefs.length) findings.push(finding('no-design-yet', 'No candidate design has been supplied.'));
  for (const ref of designRefs) {
    if (!ref.endsWith('.json')) continue;
    let design;
    try { design = JSON.parse(await input(repoRoot, ref)); }
    catch { findings.push(finding('unsupported-design-form', `Cannot inspect design ${ref}.`)); continue; }
    if (validateRecord('action-map', design).ok || validateRecord('environment', design).ok) continue;
    const check = validateRecord('design', design);
    if (!check.ok) { findings.push(finding('unsupported-design-form', `Design ${ref} does not match the supported v1 record.`)); continue; }
    if (design.planId !== planRecordId) findings.push(finding('design-plan-mismatch', `Design ${ref} cites a different original plan.`));
    if (design.mode !== mode) findings.push(finding('design-mode-mismatch', `Design ${ref} declares another mode.`));
    for (const dependency of [...design.sourceRefs, ...design.modelRefs, ...design.configRefs, ...design.dependencyRefs]) {
      if (!refs.has(dependency)) findings.push(finding('incomplete-inventory', `Declared reference ${dependency} is absent from the captured bundle.`));
    }
    const mapped = new Set();
    for (const mapRef of design.sourceRefs) {
      if (!refs.has(mapRef)) continue;
      let map;
      try { map = JSON.parse(await input(repoRoot, mapRef)); } catch { continue; }
      if (validateRecord('action-map', map).ok && design.actionIds.includes(map.actionId)) mapped.add(map.actionId);
    }
    for (const actionId of design.actionIds) if (!mapped.has(actionId)) findings.push(finding('missing-action-map', `Declared action ${actionId} has no supported action map in ${ref}; its semantics remain unknown.`, actionId));
    if (!refs.has(design.environmentId)) findings.push(finding('incomplete-inventory', `Environment inventory ${design.environmentId} is missing from the captured references.`));
    else {
      let environment;
      try { environment = JSON.parse(await input(repoRoot, design.environmentId)); } catch { /* invalid inventory is a finding */ }
      if (!validateRecord('environment', environment).ok || environment.omissions.length) findings.push(finding('incomplete-inventory', `Environment inventory ${design.environmentId} is incomplete or unsupported.`));
      if (validateRecord('environment', environment).ok) for (const event of environment.events) {
        if (!design.actionIds.includes(event)) findings.push(finding('missing-action-representation', `Declared event ${event} has no modeled action in ${ref}.`, event));
      }
    }
  }
  return findings;
}

/** Prepare one owned attempt. Callers provide the repository revision and owner; no checker or build runs here. */
export async function prepare(request, { repoRoot, storeRoot = path.join(repoRoot, '.scratch/model-fidelity'), owner, sourceRevision, checker = 'not-run' }) {
  const valid = validateRecord('request', request);
  if (!valid.ok || request.operation !== 'prepare' || ![request.unitId, request.attemptId, request.requestId].every(safeId)) throw fail('invalid-request', valid.errors.join('; ') || 'Expected prepare request with safe IDs');
  const { mode, planRef, designRefs, planId: citedPlanId } = request.payload;
  if (designRefs.includes(planRef) || new Set(designRefs).size !== designRefs.length) throw fail('invalid-request', 'Plan and design references must be distinct');
  const planBytes = await input(repoRoot, planRef);
  const plan = JSON.parse(planBytes);
  const planCheck = validateRecord('plan', plan);
  if (!planCheck.ok) throw fail('invalid-plan', planCheck.errors.join('; '));
  for (const ref of designRefs) await input(repoRoot, ref);
  const claim = await createAttempt({ storeRoot, unitId: request.unitId, attemptId: request.attemptId, owner });
  let planId = citedPlanId;
  let substitution = false;
  let missingCitation = false;
  const plansDir = path.join(storeRoot, 'units', request.unitId, 'plans');
  if (!planId) {
    const existing = await readdir(plansDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    missingCitation = existing.length > 0;
  }
  if (planId) {
    if (!safeId(planId)) throw fail('invalid-plan-id', 'Invalid original plan ID');
    const saved = await original(storeRoot, request.unitId, planId);
    substitution = digest(saved) !== digest(planBytes) || JSON.parse(saved).id !== plan.id;
  } else if (!missingCitation) {
    planId = `plan-${randomUUID()}`;
    const dir = path.join(plansDir, planId);
    await mkdir(plansDir, { recursive: true });
    if ((await lstat(plansDir)).isSymbolicLink()) throw fail('invalid-store', 'Symlink plan store refused');
    await mkdir(dir);
    const handle = await open(path.join(dir, 'original.json'), 'wx', 0o600);
    try { await handle.writeFile(planBytes); await handle.sync(); } finally { await handle.close(); }
  }
  const refusal = substitution || missingCitation;
  const findings = substitution ? [finding('original-plan-substitution', 'Candidate plan bytes differ from the frozen original; the substitution was refused.')] : missingCitation ? [finding('plan-id-required', 'Later prepares must cite the existing original plan ID.')] : await inventory(repoRoot, mode, plan.id, designRefs);
  const bundleId = refusal ? undefined : `bundle-${randomUUID()}`;
  const bundle = refusal ? undefined : await captureBundle(claim, { repoRoot, bundleId, sourceRevision, checker, files: [planRef, ...designRefs] });
  const result = {
    schema: 'model-fidelity.result.v1', requestId: request.requestId, unitId: request.unitId, attemptId: request.attemptId,
    operation: 'prepare', status: refusal ? 'error' : findings.length ? 'partial' : 'complete', continuation: 'continue', ...(planId ? { planId } : {}),
    ...(bundleId ? { bundleId } : {}), findings, checks: [], correspondence: mode === 'light' ? 'implementation-correspondence-not-assessed' : 'not-assessed', runtime: 'not-run',
    diagrams: [], artifactIds: bundle ? [`units/${request.unitId}/attempts/${request.attemptId}/input/bundles/${bundleId}/manifest.json`] : [],
    errors: refusal ? [{ code: substitution ? 'original-plan-substitution' : 'plan-id-required', message: 'Original plan unchanged' }] : [], authorityCreated: false,
  };
  const artifact = await publishOutput(claim, { kind: 'result', ids: { requestId: request.requestId }, bytes: encode(result) });
  return { ...result, resultArtifact: artifact, ...(bundle ? { manifestDigest: bundle.manifestDigest } : {}) };
}
