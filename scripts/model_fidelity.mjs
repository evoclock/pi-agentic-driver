#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { prepare } from '../lib/model-fidelity/prepare.mjs';
import { check } from '../lib/model-fidelity/check.mjs';
import { assess } from '../lib/model-fidelity/assess.mjs';
import { evaluate } from '../lib/model-fidelity/evaluate.mjs';
import { publishOutput } from '../lib/model-fidelity/attempts.mjs';
import { renderView } from '../lib/model-fidelity/views.mjs';
import { validateRecord } from '../lib/model-fidelity/records.mjs';

const MAX_REQUEST = 256 * 1024;
const MAX_READ = 256 * 1024;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const error = (code, message) => Object.assign(new Error(message), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const root = process.cwd();
const store = path.join(root, '.scratch/model-fidelity');

async function localFile(base, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw error('invalid-reference', 'Expected a relative file reference');
  let current = await realpath(base);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw error('invalid-reference', 'Symlink references are not allowed');
  }
  if (!(await lstat(current)).isFile()) throw error('invalid-reference', 'Expected a regular file');
  return current;
}

async function bounded(file, limit = MAX_READ) {
  const handle = await open(file, 'r');
  try {
    if ((await handle.stat()).size > limit) throw error('read-limit', 'Artifact exceeds the inline read limit');
    return await handle.readFile();
  } finally { await handle.close(); }
}

function baseResult(request, operation = request.operation) {
  return { schema: 'model-fidelity.result.v1', requestId: request.requestId, unitId: request.unitId, attemptId: request.attemptId,
    operation, status: 'complete', continuation: 'continue', findings: [], checks: [], correspondence: 'not-assessed', runtime: 'not-run', diagrams: [], artifactIds: [], errors: [], authorityCreated: false };
}

async function claimFor(request) {
  const base = path.join(store, 'units', request.unitId, 'attempts', request.attemptId);
  const file = await localFile(store, `units/${request.unitId}/attempts/${request.attemptId}/owner.json`);
  const owner = JSON.parse(await bounded(file));
  if (owner.unitId !== request.unitId || owner.attemptId !== request.attemptId || !id(owner.owner) || typeof owner.generation !== 'string') throw error('attempt-conflict', 'Invalid attempt owner');
  return { ...owner, storeRoot: store, base };
}

function view(viewId, mode, digest, result, bundle, actions) {
  const findings = result.findings ?? [];
  const states = [{ id: 'prepared', label: 'Prepared', details: `Bundle ${bundle.bundleId}; captured inputs ${bundle.files.length}` },
    ...actions.map((actionId, i) => ({ id: `action-${i}`, actionId, label: actionId, details: `UNEXPLORED: declared action ${actionId}; no checker graph supplied` })),
    { id: 'build', label: 'Build', details: 'Caller-owned step. RUNTIME NOT RUN' },
    { id: 'undo', label: 'Compare', details: 'Caller-owned step. UNCHECKED' }];
  const transitions = states.slice(1).map((s, i) => ({ from: states[i].id, to: s.id, label: 'declared order, not checked reachability' }));
  return { schema: 'model-fidelity.view.v1', bundleDigest: digest, viewId, mode, states, transitions,
    findings: findings.map(f => f.id), omittedViews: mode === 'light' ? ['action-map', 'fault-window'].map(v => ({ viewId: v, status: 'not-applicable', reason: 'Light mode does not assess protocol correspondence' })) : [], hiddenSteps: [], grouping: {} };
}

async function diagrams(request, claim, result) {
  const bundleFile = await localFile(claim.base, `input/bundles/${request.payload.bundleId}/manifest.json`);
  const bytes = await bounded(bundleFile);
  const bundle = JSON.parse(bytes);
  if (bundle.bundleId !== request.payload.bundleId || bundle.unitId !== request.unitId || bundle.attemptId !== request.attemptId || bundle.owner !== claim.owner || bundle.generation !== claim.generation) throw error('bundle-conflict', 'Bundle does not belong to this attempt');
  // The captured design determines mode; a missing design remains an explicit partial view.
  let mode = request.payload.mode === 'light' ? 'light' : 'protocol';
  let actions = [];
  for (const item of bundle.files.slice(1).filter(f => f.path.endsWith('.json'))) {
    const source = await localFile(claim.base, `input/bundles/${bundle.bundleId}/files/${item.path}`);
    const record = JSON.parse(await bounded(source));
    if (record.schema === 'model-fidelity.design.v1') {
      mode = record.mode;
      actions = record.actionIds;
      break;
    }
  }
  const digest = hash(bytes);
  for (const viewId of ['lifecycle', 'results']) {
    const rendered = await renderView(claim, { view: view(viewId, mode, digest, result, bundle, actions), resultId: request.requestId,
      findings: result.findings, rendererPath: process.env.PAD_MF_RENDERER || undefined });
    result.diagrams.push({ viewId, status: rendered.status, artifactIds: rendered.artifactIds });
    result.artifactIds.push(...rendered.artifactIds);
    result.findings.push(...rendered.findings);
  }
  for (const viewId of ['action-map', 'fault-window']) {
    const status = mode === 'light' ? 'not-applicable' : 'unavailable';
    const reason = mode === 'light' ? 'Light mode does not assess protocol correspondence' : 'Protocol view renderer is not yet available in the first slice';
    const artifact = await publishOutput(claim, { kind: 'view', ids: { viewId, resultId: request.requestId }, name: 'failed-view.json', bytes: encode({ viewId, status, reason, bundleDigest: digest }) });
    result.diagrams.push({ viewId, status, reason, artifactIds: [artifact.path] });
    result.artifactIds.push(artifact.path);
    if (mode !== 'light') result.findings.push({ id: `${viewId}-${request.requestId}`, code: 'diagram-unavailable', message: reason, origin: 'author-claim', evidenceIds: [artifact.path] });
  }
  if (result.findings.length) result.status = 'partial';
  return result;
}

async function readArtifact(request, claim) {
  const { artifactId, resultId } = request.payload;
  const relative = resultId ? `results/${resultId}-cli.json` : artifactId;
  if (resultId && !id(resultId)) throw error('invalid-reference', 'Invalid result ID');
  if (!relative.startsWith('views/') && !relative.startsWith('results/') && !/^input\/bundles\/[^/]+\/manifest\.json$/.test(relative)) throw error('invalid-reference', 'Only published artifacts can be read');
  const file = await localFile(claim.base, relative);
  const stats = await lstat(file);
  const result = baseResult(request);
  if (stats.size > MAX_READ) {
    result.artifact = { artifactId: relative, size: stats.size, uri: `model-fidelity://units/${request.unitId}/attempts/${request.attemptId}/${relative}`, truncated: false };
  } else {
    const bytes = await bounded(file);
    result.artifact = { artifactId: relative, size: bytes.length, sha256: hash(bytes), content: file.endsWith('.json') ? JSON.parse(bytes) : bytes.toString('utf8') };
  }
  return result;
}

async function run(request) {
  const validation = validateRecord('request', request);
  if (!validation.ok || !['prepare', 'check', 'diagram', 'read', 'assess', 'evaluate'].includes(request.operation) || ![request.unitId, request.attemptId, request.requestId].every(id)) throw error('invalid-request', validation.errors.join('; ') || 'Unsupported operation or invalid ID');
  if (['diagram', 'check', 'assess'].includes(request.operation) && !id(request.payload.bundleId)) throw error('invalid-request', 'Invalid bundle ID');
  if (request.operation === 'assess' && ![...request.payload.reviewArtifactIds, ...request.payload.checkResultIds].every(id)) throw error('invalid-request', 'Invalid evidence ID');
  const scratch = path.join(root, '.scratch');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  if ((await lstat(scratch)).isSymbolicLink()) throw error('invalid-store', 'Scratch root must not be a symlink');
  await mkdir(store, { recursive: true, mode: 0o700 });
  if ((await lstat(store)).isSymbolicLink()) throw error('invalid-store', 'Evidence store must not be a symlink');
  const cache = `units/${request.unitId}/attempts/${request.attemptId}/results/${request.requestId}-cli.json`;
  let prior;
  try { prior = JSON.parse(await bounded(await localFile(store, cache), MAX_REQUEST * 4)); }
  catch (cause) { if (!['ENOENT', 'ENOTDIR'].includes(cause.code)) throw cause; }
  const inputs = request.operation === 'prepare' ? await Promise.all([request.payload.planRef, ...request.payload.designRefs].map(async ref => bounded(await localFile(root, ref), MAX_REQUEST))) : request.operation === 'evaluate' ? await Promise.all([request.payload.changeRef, request.payload.rollbackRecordRef, process.env.PAD_MF_RED_LINES].filter(Boolean).map(async ref => bounded(await localFile(root, ref), MAX_REQUEST))) : [];
  const evidence = request.operation === 'assess' ? await Promise.all([
    `input/bundles/${request.payload.bundleId}/manifest.json`,
    ...request.payload.reviewArtifactIds.map(value => `reviews/${value}.json`),
    ...request.payload.checkResultIds.map(value => `results/${value}.json`),
  ].map(async relative => {
    try { return await bounded(await localFile(path.join(store, 'units', request.unitId, 'attempts', request.attemptId), relative)); }
    catch (cause) { if (['ENOENT', 'ENOTDIR'].includes(cause.code)) return Buffer.from(`missing:${relative}`); throw cause; }
  })) : [];
  const gitState = request.operation === 'evaluate' ? [execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }), execFileSync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: root, maxBuffer: 4 * 1024 * 1024 }), execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).scratch'], { cwd: root, maxBuffer: 4 * 1024 * 1024 })] : [];
  const fingerprint = hash(Buffer.concat([Buffer.from(encode(request)), ...inputs, ...evidence, ...gitState]));
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw error('request-conflict', 'Request ID already used with different input');
    return prior.result;
  }
  if (request.operation === 'prepare') {
    const started = await localFile(store, `units/${request.unitId}/attempts/${request.attemptId}/owner.json`).catch(() => null);
    if (started) throw error('interrupted', 'Attempt exists without a completed CLI result; start a new attempt');
    const result = await prepare(request, { repoRoot: root, storeRoot: store, owner: 'model-fidelity-cli', sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() });
    const claim = await claimFor(request);
    if (result.bundleId) await diagrams({ ...request, payload: { bundleId: result.bundleId, mode: request.payload.mode } }, claim, result);
    await publishOutput(claim, { kind: 'result', ids: { requestId: `${request.requestId}-cli` }, bytes: encode({ fingerprint, result }) });
    return result;
  }
  const claim = await claimFor(request);
  // A failed publication is not replayed. The caller must use a new request and attempt.
  const existing = await localFile(claim.base, `results/${request.requestId}.json`).catch(() => null);
  if (existing) throw error('interrupted', 'Result exists without a completed CLI record');
  if (request.operation === 'evaluate') {
    const partialEvaluation = await localFile(claim.base, `evaluation/${request.requestId}/result.json`).catch(() => null);
    const partialView = await localFile(claim.base, `views/lifecycle/${request.requestId}/view.json`).catch(() => null);
    if (partialEvaluation || partialView) throw error('interrupted', 'Evaluation or view exists without a completed CLI result; use a new request ID');
  }
  if (['diagram', 'assess'].includes(request.operation)) {
    const partialView = await localFile(claim.base, `views/lifecycle/${request.requestId}/view.json`).catch(() => null);
    if (partialView) throw error('interrupted', 'View exists without a completed CLI result; use a new request ID');
  }
  let result = baseResult(request);
  if (request.operation === 'check') {
    result = await check(request, claim);
    result = await diagrams(request, claim, result);
  } else if (request.operation === 'diagram') {
    for (const previousId of request.payload.resultIds ?? []) {
      if (!id(previousId)) throw error('invalid-request', 'Invalid prior result ID');
      const previous = JSON.parse(await bounded(await localFile(claim.base, `results/${previousId}-cli.json`), MAX_REQUEST * 4)).result;
      if (previous.unitId !== request.unitId || previous.attemptId !== request.attemptId || previous.bundleId !== request.payload.bundleId) throw error('bundle-conflict', 'Prior result belongs to another bundle');
      result.findings.push(...previous.findings);
    }
    result = await diagrams(request, claim, result);
  } else if (request.operation === 'assess') {
    result = await assess(request, claim);
    result = await diagrams(request, claim, result);
  } else if (request.operation === 'evaluate') {
    result = await evaluate(request, { claim, repoRoot: root, storeRoot: store, localFile, bounded, baseResult });
    result = await diagrams({ ...request, payload: { bundleId: result.bundleId } }, claim, result);
    await publishOutput(claim, { kind: 'evaluation', ids: { resultId: request.requestId }, name: 'result.json', bytes: encode(result) });
  } else result = await readArtifact(request, claim);
  await publishOutput(claim, { kind: 'result', ids: { requestId: request.requestId }, bytes: encode(result) });
  await publishOutput(claim, { kind: 'result', ids: { requestId: `${request.requestId}-cli` }, bytes: encode({ fingerprint, result }) });
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[1] !== '--json' || !['prepare', 'check', 'diagram', 'read', 'assess', 'evaluate'].includes(args[0])) throw error('invalid-input', 'Usage: model_fidelity.mjs prepare|check|diagram|read|assess|evaluate --json REQUEST_FILE');
  let file;
  try { file = await localFile(root, args[2]); }
  catch (cause) { if (cause.code === 'ENOENT') throw error('invalid-input', 'Request file does not exist'); throw cause; }
  const request = JSON.parse(await bounded(file, MAX_REQUEST));
  if (request.operation !== args[0]) throw error('invalid-request', 'Operation and subcommand differ');
  return run(request);
}

try { process.stdout.write(encode(await main())); }
catch (cause) {
  const code = cause.code === 'request-conflict' || cause.code === 'attempt-conflict' ? cause.code : cause.code ?? 'operational-error';
  const invalid = ['invalid-input', 'invalid-request', 'invalid-reference', 'invalid-plan', 'read-limit', 'ERR_INVALID_ARG_TYPE'].includes(code) || cause instanceof SyntaxError || cause instanceof TypeError;
  const message = ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOTDIR'].includes(code) ? `File operation failed (${code})` : cause.message;
  process.stdout.write(encode({ schema: 'model-fidelity.error.v1', status: 'error', continuation: 'continue', errors: [{ code: cause instanceof SyntaxError ? 'invalid-json' : code, message }], authorityCreated: false }));
  process.exitCode = invalid ? 2 : 3;
}
