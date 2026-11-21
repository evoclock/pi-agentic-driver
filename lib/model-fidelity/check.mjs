import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { publishOutput } from './attempts.mjs';
import { validateRecord } from './records.mjs';
import { runTlcChecks, ADAPTER } from './tlc-runner.mjs';
import { classifyTlcOutcome } from './tlc-outcome.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const DELIVERY_CONTINUATION = 'continue';
// Why: a check result must keep delivering rather than blocking on expected findings.
export function isContinue(continuation) {
  return continuation === 'continue';
}
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const encode = value => `${JSON.stringify(value, null, 2)}\n`;

async function captured(base, bundle, item) {
  if (!item || typeof item.path !== 'string' || item.path.split('/').some(p => !p || p === '.' || p === '..') || item.path.includes('\\')) throw fail('bundle-conflict', 'Invalid captured path');
  let at = path.join(base, 'input', 'bundles', bundle.bundleId, 'files');
  for (const part of item.path.split('/')) {
    at = path.join(at, part);
    if ((await lstat(at)).isSymbolicLink()) throw fail('bundle-conflict', 'Captured input is a symlink');
  }
  const bytes = await readFile(at);
  if (sha(bytes) !== item.sha256 || bytes.length !== item.size) throw fail('bundle-conflict', 'Captured input bytes changed');
  return { file: at, bytes };
}

function properties(bytes) {
  const lines = bytes.toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => /^(?:INVARIANT|PROPERTY)\s+/.test(line));
  const names = lines.map(line => line.split(/\s+/)[1]);
  return names.length && names.every(name => /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) ? names : [];
}

export async function check(request, claim) {
  if (!validateRecord('request', request).ok || request.operation !== 'check' || !id(request.payload.bundleId)) throw fail('invalid-request', 'Invalid check request');
  const { bundleId, controlIds = [], limits = {} } = request.payload;
  if (!Array.isArray(controlIds) || controlIds.length > 8 || controlIds.some(name => !id(name)) || new Set(controlIds).size !== controlIds.length) throw fail('invalid-request', 'Invalid control IDs');
  if (Object.keys(limits).some(key => !['timeoutSeconds', 'maxOutputBytes', 'maxStates'].includes(key))) throw fail('invalid-request', 'Unknown check limit');
  const base = claim.base ?? path.join(claim.storeRoot, 'units', claim.unitId, 'attempts', claim.attemptId);
  const manifestFile = path.join(base, 'input', 'bundles', bundleId, 'manifest.json');
  if ((await lstat(manifestFile)).isSymbolicLink()) throw fail('bundle-conflict', 'Symlink manifest');
  const manifest = JSON.parse(await readFile(manifestFile));
  if (manifest.bundleId !== bundleId || manifest.unitId !== claim.unitId || manifest.attemptId !== claim.attemptId || manifest.owner !== claim.owner || manifest.generation !== claim.generation) throw fail('bundle-conflict', 'Bundle belongs to another attempt');
  const designs = [];
  for (const item of manifest.files.filter(file => file.path.endsWith('.json'))) {
    const capturedFile = await captured(base, manifest, item);
    let record;
    try { record = JSON.parse(capturedFile.bytes); } catch { continue; }
    if (record.schema === 'model-fidelity.design.v1') designs.push(record);
  }
  const design = designs[0];
  if (designs.length !== 1 || !validateRecord('design', design).ok || !design.modelRefs.length || !design.configRefs.length) throw fail('invalid-request', 'Bundle needs one supported design with model and config references');
  const entries = new Map(manifest.files.map(item => [item.path, item]));
  const models = await Promise.all(design.modelRefs.map(async ref => captured(base, manifest, entries.get(ref))));
  const configs = await Promise.all(design.configRefs.map(async ref => captured(base, manifest, entries.get(ref))));
  const primaryProperties = properties(configs[0].bytes);
  if (!primaryProperties.length) throw fail('invalid-request', 'Primary config must name a safety invariant or property');
  const result = { schema: 'model-fidelity.result.v1', requestId: request.requestId, unitId: request.unitId, attemptId: request.attemptId,
    operation: 'check', status: 'complete', continuation: isContinue(DELIVERY_CONTINUATION) ? 'continue' : 'stop', bundleId, findings: [], checks: [], correspondence: 'not-assessed', runtime: 'not-run', diagrams: [], artifactIds: [], errors: [], authorityCreated: false };
  const controls = design.configRefs.slice(1).map((ref, index) => ({ id: path.basename(ref, path.extname(ref)), index: index + 1 }));
  if (new Set(controls.map(c => c.id)).size !== controls.length || controlIds.some(name => !controls.some(c => c.id === name))) throw fail('invalid-request', 'Control ID is not a named captured config');
  const selected = [{ id: 'primary', index: 0 }, ...controls.filter(c => controlIds.includes(c.id))];
  const runnable = [];
  for (const entry of selected) {
    const sameRule = JSON.stringify(properties(configs[entry.index].bytes)) === JSON.stringify(primaryProperties);
    const model = models.length === 1 ? models[0] : models[entry.index];
    if (!sameRule || !model) {
      result.checks.push({ name: entry.id, status: 'invalid', reason: !sameRule ? 'safety-property-changed' : 'missing-paired-model' });
      result.findings.push({ id: `control-${entry.id}`, code: 'invalid-control', message: `Control ${entry.id} does not retain the primary safety property or a paired model.`, origin: 'inspected-source', evidenceIds: [] });
      continue;
    }
    runnable.push({ name: entry.id, spec: model.file, config: configs[entry.index].file, properties: primaryProperties, out: path.join(base, 'checks', request.requestId, entry.id) });
  }
  if (runnable.length && limits.maxStates == null && !(await lstat(ADAPTER).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))) {
    for (const item of runnable) {
      result.checks.push({ name: item.name, status: 'unavailable', reason: 'installed-checker-adapter-missing' });
      result.findings.push({ id: `check-${item.name}`, code: 'check-unavailable', message: `Check ${item.name} cannot run because the installed checker adapter is missing.`, origin: 'model-run', evidenceIds: [] });
    }
    runnable.length = 0;
  }
  if (runnable.length) {
    const priorRun = await lstat(path.join(base, 'checks', request.requestId)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (priorRun) throw fail('interrupted', 'Check output exists without a published result; use a new request ID');
    const timeout = limits.timeoutSeconds ?? 60;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300) throw fail('invalid-request', 'Invalid timeout');
    const budget = { totalMs: timeout * 1000, checkMs: Math.min(timeout * 1000, 30000), outputBytes: limits.maxOutputBytes ?? 4 * 1024 * 1024, stateLimit: limits.maxStates ?? null };
    const run = await runTlcChecks({ checks: runnable, budget });
    for (const raw of run.raw ?? []) {
      const text = raw.checkerOutput ?? raw.output;
      const outcome = classifyTlcOutcome({ stdout: text, exitCode: raw.adapterResult?.checkerExit ?? raw.exitCode, errorCode: raw.errorCode ?? (raw.adapterResult?.status === 'blocked' ? 'CHECKER_UNAVAILABLE' : null), timedOut: raw.timedOut, truncated: raw.outputTruncated, properties: raw.properties });
      const artifact = await publishOutput(claim, { kind: 'result', ids: { requestId: `${request.requestId}-${raw.name}-raw` }, bytes: encode(raw) });
      result.artifactIds.push(artifact.path);
      const control = raw.name !== 'primary';
      const status = control ? outcome.status === 'counterexample' && outcome.counterexampleProperties.some(p => primaryProperties.includes(p)) ? 'exposed' : outcome.status === 'no-counterexample' ? 'survived' : ['error', 'counterexample'].includes(outcome.status) ? 'invalid' : 'not-run' : outcome.status;
      result.checks.push({ name: raw.name, status, outcome, rawArtifactId: artifact.path, checker: raw.checker, config: raw.inputs.config });
      if (status !== 'no-counterexample') result.findings.push({ id: `check-${raw.name}`, code: status === 'exposed' || status === 'counterexample' ? 'counterexample' : `check-${status}`, message: `Check ${raw.name}: ${status}.`, origin: 'model-run', evidenceIds: [artifact.path] });
    }
    for (const name of run.unchecked ?? []) {
      result.checks.push({ name, status: 'not-run', reason: run.status });
      result.findings.push({ id: `check-${name}`, code: 'check-not-run', message: `Check ${name} did not run within the total budget.`, origin: 'model-run', evidenceIds: [] });
    }
    if (run.status === 'unsupported-state-limit') result.findings.push({ id: 'state-limit', code: 'unsupported-state-limit', message: 'Installed checker cannot enforce the requested state limit.', origin: 'model-run', evidenceIds: [] });
  }
  result.findings.push({ id: 'reachability-deferred', code: 'reachability-not-assessed', message: 'Shadowed and unreachable-within-bounds require a separate reachability witness; neither is inferred from a passing control.', origin: 'author-claim', evidenceIds: [] });
  if (result.findings.length) result.status = 'partial';
  return result;
}
