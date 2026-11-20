// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
// PAD-owned, same-user file channel. No terminal transport or process control.
import { createHash, randomUUID } from 'node:crypto';
import { writeSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const WORKER_ABORT_SCHEMA = 'agentic-driver.worker-abort.v1';
const FRESH_MS = 15000;
const REQUEST_MS = 15000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const text = (value, max = 512) => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max;
const clock = (options) => (options.now ?? Date.now)();
function fail(code) { throw Object.assign(new Error(code), { code, workerAbort: true, status: 'refused' }); }

function controlRoot(options) {
  return join(resolve(options.workerControlDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent')), 'agentic/worker-control');
}
// Existing approval and recovery ledgers are authority-specific, so do not add
// abort observations to them. Use their append-only JSONL convention here.
function privateDir(path) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail('abort_channel_unsafe');
  return path;
}
function rootDir(options, create = false) {
  const root = controlRoot(options);
  if (create) {
    // Profile is selected by the host; never read or modify its settings.
    const profile = resolve(root, '../..');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const parent = join(profile, 'agentic');
    try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) fail('abort_channel_unsafe');
    privateDir(root);
  } else {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail('abort_channel_unsafe');
  }
  return root;
}
function sessionDir(sessionId, options, create = false) {
  if (!text(sessionId)) fail('abort_capability_unavailable');
  const path = join(rootDir(options, create), hash(sessionId));
  if (create) return privateDir(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail('abort_channel_unsafe');
  return path;
}
function readJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) fail('abort_channel_unsafe');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function atomicJson(path, value, exclusive = false) {
  const tmp = `${path}.${randomUUID()}.pending`;
  writeFileSync(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  if (!exclusive) { renameSync(tmp, path); return true; }
  try { linkSync(tmp, path); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { unlinkSync(tmp); }
}
const turnFile = (dir, kind, turnId) => join(dir, `${kind}-${hash(turnId)}.json`);
function appendAudit(options, record) {
  const path = join(rootDir(options, true), 'audit.jsonl');
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) fail('abort_channel_unsafe');
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally { closeSync(fd); }
}
export async function auditWorkerAbort(params, context, options, execute) {
  const identity = {};
  const attempt = { schema: WORKER_ABORT_SCHEMA, attemptId: randomUUID(), timestamp: clock(options),
    operation: params.action,
    role: text(params.role, 64) ? params.role : null,
    requestedRepository: context?.repository ?? context?.cwd ?? null,
    turnId: text(params.turnId) ? params.turnId : null, toolCallId: text(params.toolCallId) ? params.toolCallId : null,
    reason: text(params.reason, 1024) ? params.reason : null,
    requestingAgent: context?.sessionManager?.getSessionId?.() ?? process.env.HERDR_PANE_ID ?? 'unknown',
    repository: null, sessionId: null };
  const refused = () => ({ schema: 'agentic-driver.herdr-communication.v1', ok: false, operation: params.action, status: 'refused',
    code: 'abort_audit_unavailable', reason: 'abort audit could not be written', nonAuthorizing: true, authorityCreated: false });
  try { appendAudit(options, { ...attempt, phase: 'attempt', outcome: 'requested' }); } catch { return refused(); }
  const result = await execute({ ...options, abortAuditIdentity: identity });
  try { appendAudit(options, { ...attempt, ...identity, phase: 'outcome', outcome: result.code ?? result.status }); }
  catch { return result.ok ? { ...result, auditWarning: 'outcome_write_failed' } : refused(); }
  return result;
}
export function validateAbortIdentity(params) {
  if (!text(params.turnId) && !text(params.toolCallId)) fail('turn_identity_required');
  for (const key of ['turnId', 'toolCallId']) if (params[key] !== undefined && !text(params[key])) fail('turn_identity_required');
  if (!text(params.reason, 1024)) fail('abort_reason_required');
  if (params.allowPiQueueRestore !== undefined && typeof params.allowPiQueueRestore !== 'boolean') fail('invalid_parameters');
}
export function workerAbortCapability(observation, options = {}) {
  try {
    const cap = readJson(join(sessionDir(observation.sessionId, options), 'capability.json'));
    const age = clock(options) - cap.updatedAt;
    if (cap.schema !== WORKER_ABORT_SCHEMA || cap.sessionId !== observation.sessionId || !Number.isFinite(age)
      || age < 0 || age > FRESH_MS || cap.repository !== observation.repository || !text(cap.paneId)
      || cap.paneId !== observation.paneId
      || typeof cap.running !== 'boolean' || !Array.isArray(cap.toolCallIds) || cap.toolCallIds.length > 256
      || !cap.toolCallIds.every((id) => text(id)) || (cap.running && !text(cap.turnId))) return undefined;
    return cap;
  } catch { return undefined; }
}
export function deliverWorkerAbort(params, observation, options = {}) {
  const cap = workerAbortCapability(observation, options);
  if (!cap) fail('abort_capability_unavailable');
  if (['idle', 'done'].includes(observation.status) || !cap.running) fail('turn_finished');
  if (observation.status !== 'working') fail('stale_turn');
  // Pi turn IDs are published by the listener. Herdr's status sequence is not
  // a Pi lifecycle identity and must not be translated speculatively.
  if ((params.turnId !== undefined && params.turnId !== cap.turnId)
    || (params.toolCallId !== undefined && !cap.toolCallIds.includes(params.toolCallId))) fail('stale_turn');
  const dir = sessionDir(cap.sessionId, options);
  const path = turnFile(dir, 'request', cap.turnId);
  const now = clock(options);
  const receipt = { schema: 'agentic-driver.herdr-communication.v1', ok: true, operation: 'abort', status: 'delivered',
    role: params.role, sessionId: cap.sessionId, turnId: cap.turnId, ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    reason: params.reason, abortedAt: new Date(now).toISOString(), allowPiQueueRestore: params.allowPiQueueRestore ?? false,
    nonAuthorizing: true, authorityCreated: false };
  const record = { schema: WORKER_ABORT_SCHEMA, sessionId: cap.sessionId, paneId: cap.paneId, repository: cap.repository,
    turnId: cap.turnId, toolCallId: params.toolCallId, createdAt: now, expiresAt: now + REQUEST_MS, receipt };
  try {
    if (atomicJson(path, record, true)) return receipt;
    const prior = readJson(path);
    if (prior.schema !== WORKER_ABORT_SCHEMA || prior.sessionId !== cap.sessionId || prior.turnId !== cap.turnId
      || prior.receipt?.status !== 'delivered' || prior.receipt?.role !== params.role) fail('abort_channel_unsafe');
    return prior.receipt;
  } catch (error) { if (error.workerAbort) throw error; fail('abort_channel_unavailable'); }
}

export function deliverWorkerSteer(params, observation, options = {}) {
  const cap = workerAbortCapability(observation, options);
  if (!cap || cap.steerReady !== true || observation.agentKind !== 'pi') fail('steer_capability_unavailable');
  if (!cap.running || observation.status !== 'working' || params.turnId !== cap.turnId) fail('stale_turn');
  if (!text(params.sentPrompt, 48 * 1024)) fail('steer_prompt_required');
  const now = clock(options);
  const record = { schema: WORKER_ABORT_SCHEMA, sessionId: cap.sessionId, paneId: cap.paneId,
    repository: cap.repository, turnId: cap.turnId, createdAt: now, expiresAt: now + REQUEST_MS,
    prompt: params.sentPrompt };
  if (!atomicJson(turnFile(sessionDir(cap.sessionId, options), 'steer', cap.turnId), record, true)) fail('steer_turn_already_claimed');
}

export function registerWorkerAbortListener(pi, options = {}) {
  const env = options.env ?? process.env;
  // Reuse the Herdr workspace/tab/pane convention used by skill observability.
  // No role env is set by Herdr. Role authorization stays with observeRole;
  // the file endpoint binds the actual session and pane instead of a name.
  if (!/^w[A-Za-z0-9]+$/.test(env.HERDR_WORKSPACE_ID ?? '')
    || !env.HERDR_TAB_ID?.startsWith(`${env.HERDR_WORKSPACE_ID}:t`)
    || !env.HERDR_PANE_ID?.startsWith(`${env.HERDR_WORKSPACE_ID}:p`)) return;
  let state; let ctx; let dir; let timer; let watcher; let stopped = true;
  const publish = () => atomicJson(join(dir, 'capability.json'), { ...state, toolCallIds: [...state.toolCallIds], updatedAt: clock(options) });
  const consumeSteer = () => {
    if (!state.running) return;
    const ackPath = turnFile(dir, 'steer-ack', state.turnId);
    let request;
    try { request = readJson(turnFile(dir, 'steer', state.turnId)); } catch { return; }
    try { readJson(ackPath); return; } catch (error) { if (error.code !== 'ENOENT') return; }
    const now = clock(options);
    const valid = state.steerReady && request.schema === WORKER_ABORT_SCHEMA && request.sessionId === state.sessionId
      && request.paneId === state.paneId && request.repository === state.repository && request.turnId === state.turnId
      && Number.isFinite(request.createdAt) && Number.isFinite(request.expiresAt) && request.createdAt <= now
      && request.expiresAt >= now && request.expiresAt - request.createdAt === REQUEST_MS && text(request.prompt, 48 * 1024);
    const ack = { status: valid ? 'claimed' : 'expired', timestamp: now };
    if (!atomicJson(ackPath, ack, true) || !valid) return;
    try { pi.sendUserMessage(request.prompt, { deliverAs: 'steer' }); }
    catch { atomicJson(ackPath, { status: 'uncertain', timestamp: now }); }
  };
  const consume = (filename) => {
    if (stopped || !state?.turnId) return;
    const expected = `request-${hash(state.turnId)}.json`;
    if (filename && String(filename) !== expected) return;
    const ackPath = turnFile(dir, 'ack', state.turnId);
    let request;
    try { request = readJson(join(dir, expected)); } catch { return; }
    try { readJson(ackPath); return; } catch (error) { if (error.code !== 'ENOENT') return; }
    let code;
    if (request.schema !== WORKER_ABORT_SCHEMA || request.sessionId !== state.sessionId || request.paneId !== state.paneId
      || request.repository !== state.repository || request.turnId !== state.turnId
      || !Number.isFinite(request.expiresAt) || !Number.isFinite(request.createdAt)
      || request.expiresAt < clock(options) || request.createdAt > clock(options)
      || request.expiresAt - request.createdAt !== REQUEST_MS || clock(options) - request.createdAt > REQUEST_MS
      || !text(request.receipt?.reason, 1024)
      || (request.receipt?.allowPiQueueRestore !== true && request.receipt?.allowPiQueueRestore !== false)) code = 'stale_turn';
    else if (!state.running) code = 'turn_finished';
    else if (request.toolCallId !== undefined && !state.toolCallIds.has(request.toolCallId)) code = 'stale_turn';
    else if (ctx.hasPendingMessages() && !request.receipt.allowPiQueueRestore) code = 'pi_queue_pending';
    const ack = { schema: WORKER_ABORT_SCHEMA, sessionId: state.sessionId, turnId: state.turnId,
      status: code ? 'refused' : 'abort_requested', ...(code ? { code } : {}), timestamp: clock(options) };
    // Persist claim before calling abort, so duplicate watch/poll notifications
    // and /reload cannot replay it. This ack is not proof of final settlement.
    if (!atomicJson(ackPath, ack, true) || code) return;
    try { ctx.abort(); } catch { atomicJson(ackPath, { ...ack, status: 'refused', code: 'abort_call_failed' }); }
  };
  const safeTick = (filename) => {
    if (stopped || (filename && String(filename) !== `request-${hash(state.turnId ?? '')}.json`)) return;
    try { consumeSteer(); consume(filename); publish(); } catch { stopped = true; /* capability expires closed */ }
  };
  const stop = () => {
    stopped = true; watcher?.close(); watcher = undefined;
    if (timer) (options.clearInterval ?? clearInterval)(timer); timer = undefined;
    if (state && dir) { state.running = false; state.toolCallIds.clear(); try { publish(); } catch { /* expires */ } }
  };
  pi.on('session_start', (_event, context) => {
    stop(); ctx = context;
    const sessionId = ctx.sessionManager.getSessionId();
    dir = sessionDir(sessionId, options, true);
    state = { schema: WORKER_ABORT_SCHEMA, sessionId, paneId: env.HERDR_PANE_ID, repository: resolve(ctx.cwd),
      running: false, turnId: null, toolCallIds: new Set(), steerReady: typeof pi.sendUserMessage === "function" };
    stopped = false; publish();
    // Missing filenames are only hints: the timer covers them. Do not publish
    // in response to our own capability rename (including unnamed events).
    try { watcher = (options.watch ?? watch)(dir, (_event, name) => { if (name) safeTick(name); }); watcher.on('error', () => { watcher?.close(); watcher = undefined; }); }
    catch { /* bounded fallback polls one current-turn file, never the directory */ }
    timer = (options.setInterval ?? setInterval)(() => safeTick(), 1000); timer.unref?.();
  });
  const update = (context, mutate) => {
    if (stopped || context.sessionManager.getSessionId() !== state.sessionId) return;
    ctx = context; mutate(); publish();
  };
  pi.on('turn_start', (event, context) => update(context, () => {
    state.turnId = `${event.timestamp}:${event.turnIndex}:${randomUUID()}`; state.running = true; state.toolCallIds.clear();
  }));
  pi.on('tool_execution_start', (event, context) => update(context, () => { if (state.toolCallIds.size < 256) state.toolCallIds.add(event.toolCallId); }));
  pi.on('tool_execution_end', (event, context) => update(context, () => state.toolCallIds.delete(event.toolCallId)));
  pi.on('turn_end', (_event, context) => update(context, () => { state.running = false; state.toolCallIds.clear(); }));
  pi.on('agent_end', (_event, context) => update(context, () => { state.running = false; state.toolCallIds.clear(); }));
  pi.on('session_shutdown', stop);
}
