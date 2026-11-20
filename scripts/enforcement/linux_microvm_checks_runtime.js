// Production inputs are journal-bound. Editable projections are never authority.
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { openSync, closeSync, readFileSync, fstatSync, realpathSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { readAuthorizedStatus } from '../workflow_runner_core.mjs';
import { authorityForRepository } from '../workflow_runner_authority.mjs';
import { exitRequest, countTests } from '../workflow_runner_exit.mjs';
import { outputSnapshotMatches } from '../workflow_runner_outputs.mjs';
const sha = x => createHash('sha256').update(x).digest('hex');
const canonical = x => JSON.stringify(x, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const hash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);
const host = s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,254}$/.test(s);
const pins = v => (closed(v, ['image', 'initramfs', 'taxonomy']) || closed(v, ['image', 'initramfs', 'taxonomy', 'kernel', 'firecracker'])) && Object.values(v).every(hash);
const SOURCE = {testudoCommit: '92796bc7d487b6c0a8b9128be87653f17898742b', monitor: 'd2aa2b380bb2855fcb75a1feeda72877f8e59f658697b409d8581503a5b4e97c', supervisor: 'e08c596207f020f3cbb3e8c97434ffc611105c3855a5cf60a4c300d662c0fbc4', taxonomy: '0b194cdfd86f23fd68c2685c2ccfc556a0e311e2973b1ff619c6c78791d65fcd'};
function readJSON(file, maxBytes = 32768, expectedSha256) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const s = fstatSync(fd); if (!s.isFile() || s.size > maxBytes) throw Error('unsafe metadata'); const bytes = readFileSync(fd); if (expectedSha256 && sha(bytes) !== expectedSha256) throw Error('image manifest digest mismatch'); return JSON.parse(bytes.toString('utf8')); } finally { closeSync(fd); }
}
export async function loadOwnedLinuxCheckRequest(context, runId, {authorityForRepository: authorityFor = authorityForRepository} = {}) {
  const cli = context?.mode === 'cli' && context.hasUI === false && realpathSync(context.cwd) === realpathSync(process.cwd());
  if (!(context?.isProjectTrusted?.() === true || cli) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(runId ?? '')) throw Error('untrusted native request');
  const repo = realpathSync(context.cwd), store = join(repo, '.local/workflow-runner', runId);
  if (realpathSync(store) !== store) throw Error('unsafe run store');
  const workflow = readJSON(join(store, 'workflow.json'));
  if (resolve(workflow.repo ?? '') !== repo) throw Error('request belongs to another checkout');
  const s = await readAuthorizedStatus(workflow, store, await authorityFor(repo));
  if (!s.exitClaim || s.move === 'wait' || !['awaiting', 'parked'].includes(s.phase)) throw Error('no current exit claim');
  const request = exitRequest(workflow, {...s, taskId: runId});
  if (!request?.binding || request.park || canonical(request.binding) !== canonical(s.exitClaim.binding) || !outputSnapshotMatches(repo, request.commit, request.outputs)) throw Error('exit claim changed');
  const bytes = execFileSync('git', ['-C', repo, 'archive', '--format=tar', request.commit], {maxBuffer: 16 * 1024 * 1024});
  const h = sha(canonical({claim: s.exitClaim.eventId, binding: request.binding}));
  const requestId = [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
  return {...request, schema: 'pad-linux-check-request.v1', runId, requestId, checkout: {bytes: bytes.toString('base64'), sha256: sha(bytes)}};
}
export function loadSSHChecksTarget(options = {}) {
  const profile = options.profile ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent');
  let target;
  try { target = readJSON(join(profile, 'linux-microvm-checks.json')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!closed(target, ['schema', 'sshTarget', 'pins', 'imageManifestSha256']) || target.schema !== 'pad-linux-check-target.v1' || !host(target.sshTarget) || !closed(target.pins, ['image', 'initramfs', 'taxonomy', 'kernel', 'firecracker']) || !pins(target.pins) || !hash(target.imageManifestSha256)) throw Error('invalid SSH checks target');
  const file = join(profile, 'linux-microvm-checks-image.json');
  const manifest = readJSON(file, 262144, target.imageManifestSha256);
  if (!closed(manifest, ['schema', 'testudoCommit', 'sourceDateEpoch', 'checks', 'sources', 'pins']) || manifest.schema !== 'pad-guest-image-manifest.v1' || !Number.isSafeInteger(manifest.sourceDateEpoch) || manifest.sourceDateEpoch < 0 || manifest.sourceDateEpoch > 0xffffffff || manifest.testudoCommit !== SOURCE.testudoCommit || !closed(manifest.sources, ['monitor', 'taxonomy', 'supervisor', 'busybox']) || !Object.values(manifest.sources).every(hash) || manifest.sources.monitor !== SOURCE.monitor || manifest.sources.supervisor !== SOURCE.supervisor || manifest.sources.taxonomy !== SOURCE.taxonomy || !closed(manifest.pins, ['image', 'initramfs', 'taxonomy', 'kernel', 'firecracker']) || !Object.values(manifest.pins).every(hash) || manifest.pins.taxonomy !== SOURCE.taxonomy || !Object.entries(target.pins).every(([key, value]) => manifest.pins[key] === value)) throw Error('image manifest mismatch');
  if (!manifest.checks || typeof manifest.checks !== 'object' || Array.isArray(manifest.checks) || !Object.keys(manifest.checks).length || Object.keys(manifest.checks).length > 32) throw Error('fixed check map required');
  for (const [id, row] of Object.entries(manifest.checks)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(id) || !closed(row, ['command', 'cwd', 'timeoutSeconds', 'commandSha256']) || !Array.isArray(row.command) || !row.command.length || row.command.length > 64 || row.command.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !row.command[0] || row.commandSha256 !== sha(canonical(row.command)) || typeof row.cwd !== 'string' || row.cwd.startsWith('/') || row.cwd.split('/').includes('..') || !Number.isSafeInteger(row.timeoutSeconds) || row.timeoutSeconds < 1 || row.timeoutSeconds > 600) throw Error('invalid image check map');
  }
  return {...target, mode: 'ssh', transport: 'ssh-subsystem-v1', checks: manifest.checks};
}
const decode = s => { if (typeof s !== 'string' || s.length > 8 * 1024 * 1024) throw Error('invalid base64'); const b = Buffer.from(s, 'base64'); if (b.toString('base64') !== s) throw Error('invalid base64'); return b; };
function typedRequest(input) {
  if (!closed(input, ['host', 'jobId', 'checkId', 'commandSha256', 'checkout', 'pins']) || !host(input.host) || !uuid(input.jobId) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(input.checkId ?? '')) throw Error('invalid request');
  if (!hash(input.commandSha256) || !pins(input.pins) || !closed(input.checkout, ['bytes', 'sha256']) || typeof input.checkout.bytes !== 'string' || input.checkout.bytes.length > 24 * 1024 * 1024) throw Error('invalid pins');
  const bytes = Buffer.from(input.checkout.bytes, 'base64');
  if (!bytes.length || bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== input.checkout.bytes || sha(bytes) !== input.checkout.sha256) throw Error('invalid checkout');
  return {schema: 'pad-ssh-guest-check.v1', jobId: input.jobId, checkoutSha256: input.checkout.sha256, checkId: input.checkId};
}
function protocol(input) {
  let preflight = false, phase = 'header', row = null, teardown = null, partial = '';
  const logs = []; let length = 0;
  const serial = line => {
    const record = JSON.parse(line);
    if (record.jobId !== input.jobId) throw Error('wrong guest job');
    if (phase === 'header' && closed(record, ['kind', 'jobId', 'checkId', 'checkoutSha256', 'taxonomySha256']) && record.kind === 'header' && record.checkId === input.checkId && record.checkoutSha256 === input.checkout.sha256 && record.taxonomySha256 === input.pins.taxonomy) { phase = 'armed'; return; }
    if (phase === 'armed' && closed(record, ['kind', 'jobId']) && record.kind === 'armed') { phase = 'result'; return; }
    if (phase === 'result' && closed(record, ['kind', 'jobId', 'checkId', 'source', 'commandSha256', 'exitStatus', 'outputBase64']) && record.kind === 'result' && record.source === 'guest' && record.checkId === input.checkId && record.commandSha256 === input.commandSha256 && Number.isInteger(record.exitStatus) && record.exitStatus >= 0 && record.exitStatus <= 255) { row = {exitStatus: record.exitStatus, output: decode(record.outputBase64).toString('utf8')}; phase = 'done'; return; }
    throw Error('unarmed or unbound guest result');
  };
  const frame = value => {
    if (teardown) throw Error('extra launcher frame');
    if (!preflight) {
      if (!closed(value, ['type', 'jobId', 'verified', 'pins']) || value.type !== 'preflight' || value.jobId !== input.jobId || value.verified !== true || !pins(value.pins) || !Object.entries(input.pins).every(([k, v]) => value.pins[k] === v)) throw Error('image pin mismatch');
      preflight = true; return;
    }
    if (closed(value, ['type', 'bytes']) && value.type === 'serial') {
      const bytes = decode(value.bytes); length += bytes.length;
      if (length > 4 * 1024 * 1024) throw Error('serial overflow'); logs.push(bytes); partial += bytes.toString('utf8');
      let newline; while ((newline = partial.indexOf('\n')) >= 0) { const line = partial.slice(0, newline).replace(/\r$/, ''); partial = partial.slice(newline + 1); serial(line); }
      return;
    }
    if (closed(value, ['type', 'jobId', 'destroyed', 'watchdog', 'logSha256']) && value.type === 'teardown' && value.jobId === input.jobId && phase === 'done' && !partial && value.destroyed === true && value.watchdog === false && value.logSha256 === sha(Buffer.concat(logs))) { teardown = value; return; }
    throw Error('unverified teardown or log');
  };
  return {frame, evidence: () => { const bytes = Buffer.concat(logs); return {logSha256: sha(bytes), logBase64: bytes.toString('base64')}; }, complete: () => Boolean(preflight && phase === 'done' && teardown), result: () => row};
}
const failed = (reason, evidence = {}) => ({status: 'failed', exitStatus: 126, reason, retryable: false, ...evidence});
export async function runSSHCheck(input, options = {}) {
  let request; try { request = typedRequest(input); } catch { return failed('invalid-request'); }
  return exchange(input, request, protocol(input), options);
}
export async function probeSSHChecks(input, options = {}) {
  if (!closed(input, ['host', 'jobId', 'pins']) || !host(input.host) || !uuid(input.jobId) || !pins(input.pins)) return failed('invalid-request');
  let seen = false;
  const reader = {frame: value => {
    if (seen || !closed(value, ['type', 'jobId', 'verified', 'pins']) || value.type !== 'preflight' || value.jobId !== input.jobId || value.verified !== true || !pins(value.pins) || !Object.entries(input.pins).every(([k, v]) => value.pins[k] === v)) throw Error('readiness mismatch');
    seen = true;
  }, evidence: () => ({pinsVerified: seen, pins: input.pins}), complete: () => seen, result: () => ({exitStatus: 0, output: ''})};
  return exchange(input, {schema: 'pad-ssh-guest-probe.v1', jobId: input.jobId}, reader, {timeoutMs: 5000, ...options});
}
function exchange(input, request, reader, {spawnProcess = spawn, signal, timeoutMs = 120000} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) return Promise.resolve(failed('invalid-deadline'));
  if (signal?.aborted) return Promise.resolve(failed('cancelled'));
  return new Promise(resolve => {
    let child, ended = false, buffer = '', total = 0, stderr = 0, reason = null, timer, killTimer;
    const settle = value => { if (ended) return; ended = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); resolve(value); };
    const stop = why => { reason ??= why; if (child) { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000); } };
    const abort = () => stop('cancelled');
    const args = ['-F', '/dev/null', '-T', '-s', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'RemoteCommand=none', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=1', '--', input.host, 'pad-guest-check-v1'];
    try { child = spawnProcess('ssh', args, {stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: {PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8'}}); } catch { settle(failed('ssh-start-failed')); return; }
    signal?.addEventListener('abort', abort, {once: true}); timer = setTimeout(() => stop('watchdog'), timeoutMs);
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      total += Buffer.byteLength(chunk); if (total > 8 * 1024 * 1024) { stop('launcher-overflow'); return; }
      buffer += chunk;
      try { let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); reader.frame(JSON.parse(line)); } } catch { stop('launcher-evidence-invalid'); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.length; if (stderr > 262144) stop('launcher-overflow'); });
    child.stdin.on('error', () => stop('ssh-disconnected'));
    child.on('error', () => settle(failed('ssh-start-failed', reader.evidence())));
    child.on('close', (code, exitSignal) => {
      const evidence = reader.evidence(); if (signal?.aborted) reason = 'cancelled';
      if (reason || code !== 0 || exitSignal || buffer || !reader.complete()) { settle(failed(reason ?? 'ssh-disconnected', evidence)); return; }
      const row = reader.result(); settle(row.exitStatus === 0 ? {status: 'completed', ...row, ...evidence, retryable: false} : {...failed(row.exitStatus === 126 ? 'killswitch-trip' : 'check-failed', evidence), ...row});
    });
    child.stdin.end(JSON.stringify(request) + '\n' + (input.checkout ? input.checkout.bytes + '\n' : ''));
  });
}
export async function runConfiguredSSHChecks(request, target, signal, current, send = runSSHCheck) {
  if (target?.transport !== 'ssh-subsystem-v1' || !target.checks) throw Error('checks-runner-unavailable');
  const results = [], logs = [], deadline = performance.now() + 1800000; let tripped = false, total = 0;
  for (const check of request.checks) {
    const fixed = target.checks[check.id];
    if (!fixed || canonical(fixed.command) !== canonical(check.command) || fixed.cwd !== (check.cwd ?? '.') || fixed.timeoutSeconds !== (check.timeoutSeconds ?? 120)) throw Error('check not in pinned image');
  }
  for (const check of request.checks) {
    if (!await current() || signal?.aborted) throw Error('native claim fenced');
    const h = sha(request.requestId + '/' + check.id), jobId = [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
    const timeoutMs = Math.min(600000, Math.floor(deadline - performance.now())); if (timeoutMs < 1) throw Error('guest total deadline');
    const r = await send({host: target.sshTarget, jobId, checkId: check.id, commandSha256: sha(canonical(check.command)), checkout: request.checkout, pins: target.pins}, {signal, timeoutMs});
    if (r.status !== 'completed' && !['check-failed', 'killswitch-trip'].includes(r.reason)) throw Error('guest evidence unavailable');
    if (!await current() || signal?.aborted) throw Error('native claim fenced');
    total += Buffer.byteLength(r.logBase64 ?? '') + Buffer.byteLength(r.output ?? ''); if (total > 8 * 1024 * 1024) throw Error('result budget');
    results.push({id: check.id, commandSha256: sha(canonical(check.command)), exitStatus: r.exitStatus, output: r.output, tests: ['test', 'invariant-test'].includes(check.kind) ? countTests(check.counter, r.output) : null});
    logs.push({checkId: check.id, logBase64: r.logBase64, logSha256: r.logSha256});
    if (r.reason === 'killswitch-trip') { tripped = true; break; }
  }
  if (tripped) for (const check of request.checks.slice(results.length)) results.push({id: check.id, commandSha256: sha(canonical(check.command)), exitStatus: 126, output: '', tests: null, notRun: true});
  const log = canonical(logs);
  return {schema: 'pad-linux-check-result.v1', source: 'guest', requestId: request.requestId, guestRun: request.requestId, binding: request.binding, checkoutSha256: request.checkout.sha256, runtimeSha256: target.pins.image, cancelled: false, teardown: {verified: true}, results, containment: {verified: true, armed: true, taxonomySha256: target.pins.taxonomy, tripped, exitStatus: tripped ? 126 : 0, log, logSha256: sha(log)}};
}
export function productionChecksDrivers(options = {}) {
  return {loadRequest: (context, runId) => loadOwnedLinuxCheckRequest(context, runId, options), loadTarget: () => loadSSHChecksTarget(options),
    probe: async (request, target, signal) => {
      if (!request?.requestId || target?.transport !== 'ssh-subsystem-v1') return null;
      const r = await probeSSHChecks({host: target.sshTarget, jobId: randomUUID(), pins: target.pins}, {signal});
      return {requestId: request.requestId, pinsVerified: r.status === 'completed' && r.pinsVerified === true, taxonomySha256: target.pins.taxonomy};
    }, run: (request, target, signal, current = async () => false) => runConfiguredSSHChecks(request, target, signal, current)};
}
