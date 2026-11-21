import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pendingCancelStore } from './workflow_runner_authority_pending.mjs';

export async function authorityForRepository(repo) {
  let config;
  try { config = JSON.parse(readFileSync(join(repo, '.pi', 'workflow-runner-authority.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return loadAuthority(config ? { ...config, stateDir: join(repo, '.local', 'workflow-runner', '.authority-client') } : undefined);
}

/** @typedef {'remote-do'|'local-daemon'|'none'} AuthorityKind
 * @typedef {{commitCancel:Function, readEpoch:Function, casAdmitEffect:Function, status:Function}} AuthorityBackend
 * Backends return the v1.1 envelope. A successful mutation is durable before
 * resolving. The daemon loader exports createLocalAuthority(config, dependencies).
 */
export const AUTHORITY_ERROR_CODES = Object.freeze([
  'CAS_CONFLICT', 'CANCELLED', 'LEASE_EXPIRED', 'UNKNOWN_EFFECT_PENDING',
  'IDEMPOTENCY_MISMATCH', 'BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN',
  'AUTHORITY_DISABLED', 'TENANT_MISMATCH', 'AUTHORITY_UNAVAILABLE',
  'AUTHORITY_UNCONFIGURED', 'BACKEND_NOT_IMPLEMENTED', 'STALE_AUTHORITY',
  'RESTORE_WOULD_REWIND', 'CANCEL_PENDING', 'PENDING_STORE_UNCONFIGURED', 'PENDING_STORE_UNAVAILABLE',
]);
const terminal = new Set(['STALE_AUTHORITY', 'TENANT_MISMATCH', 'IDEMPOTENCY_MISMATCH',
  'BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN']);
const opaqueId = /^[A-Za-z0-9_-]{8,64}$/;
export function authorityError(code, retryable = false) {
  return { ok: false, error: { code, message: code, retryable }, parkReason: code };
}
export function parseAuthorityConfig(config) {
  if (!config || config.kind === 'none') return { kind: 'none' };
  if (!['remote-do', 'local-daemon'].includes(config.kind)) return { ...config, kind: 'unsupported' };
  if (!opaqueId.test(config.tenantId ?? '') || !opaqueId.test(config.taskId ?? '')) throw new Error('BAD_REQUEST: opaque authority identity required');
  return { ...config };
}
const methods = ['commitCancel', 'readEpoch', 'casAdmitEffect', 'status'];
export async function loadAuthority(config, dependencies = {}) {
  const parsed = parseAuthorityConfig(config);
  let backend;
  if (parsed.kind === 'remote-do') {
    const { createRemoteAuthority } = await import('./workflow_runner_authority_remote.mjs');
    backend = createRemoteAuthority({ ...parsed, ...dependencies });
  } else if (parsed.kind === 'local-daemon') {
    try {
      const loaded = await (dependencies.localLoader ?? (() => import('./workflow_runner_authority_local.mjs')))();
      backend = typeof loaded.createLocalAuthority === 'function' ? await loaded.createLocalAuthority(parsed, dependencies) : loaded;
      if (!methods.every(name => typeof backend?.[name] === 'function')) backend = undefined;
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
  }
  return createAuthorityClient({ ...parsed, backend, unavailableCode: parsed.kind === 'none' ? 'AUTHORITY_UNCONFIGURED' : 'BACKEND_NOT_IMPLEMENTED' });
}

export function createAuthorityClient({ backend, tenantId, taskId, stateDir, clientSeenSeq = 0, unavailableCode = 'AUTHORITY_UNCONFIGURED' } = {}) {
  let seen = clientSeenSeq, pendingCancels = [], fatal = null, store;
  function refreshPending() {
    try {
      pendingCancels = store?.load() ?? [];
      seen = Math.max(seen, ...pendingCancels.map(body => body.clientSeenSeq));
      return true;
    } catch { fatal = 'PENDING_STORE_UNAVAILABLE'; return false; }
  }
  try { store = pendingCancelStore({ stateDir, tenantId, taskId }); refreshPending(); }
  catch { fatal = 'PENDING_STORE_UNAVAILABLE'; }
  async function call(op, body) {
    if (fatal) return authorityError(fatal);
    if (typeof backend?.[op] !== 'function') return authorityError(unavailableCode);
    let result;
    try { result = await backend[op](body); } catch { return authorityError('AUTHORITY_UNAVAILABLE', true); }
    if (!result || typeof result.ok !== 'boolean') return authorityError('AUTHORITY_UNAVAILABLE', true);
    // Old idempotency responses legitimately contain their original sequence.
    // Fresh reads, not a cached replay response, establish authority freshness.
    if (Number.isSafeInteger(result.seq)) {
      if (result.seq < seen && (op === 'readEpoch' || !result.replayed)) { fatal = 'STALE_AUTHORITY'; return authorityError(fatal); }
      seen = Math.max(seen, result.seq);
    } else if (result.ok) return authorityError('AUTHORITY_UNAVAILABLE', true);
    if (result.tenantId !== undefined && result.tenantId !== tenantId || result.taskId !== undefined && result.taskId !== taskId) {
      fatal = 'TENANT_MISMATCH'; return authorityError(fatal);
    }
    if (!result.ok) {
      const code = AUTHORITY_ERROR_CODES.includes(result.error?.code) ? result.error.code : 'AUTHORITY_UNAVAILABLE';
      if (terminal.has(code)) fatal = code;
      return { ...result, parkReason: code };
    }
    return result;
  }
  const bodyFor = body => ({ ...body, tenantId, taskId, requestId: body.requestId ?? randomUUID(), clientSeenSeq: body.clientSeenSeq ?? seen });
  async function drainPending() {
    if (!refreshPending()) return { ...authorityError(fatal), accepted: false, acknowledged: false };
    let latest;
    for (const request of [...pendingCancels]) {
      const result = await call('commitCancel', request);
      if (!result.ok) return { ...result, accepted: true, acknowledged: false, state: 'cancel_pending' };
      try { store.remove(request.requestId); }
      catch { fatal = 'PENDING_STORE_UNAVAILABLE'; return { ...authorityError(fatal), accepted: true, acknowledged: false, state: 'cancel_pending' }; }
      pendingCancels = pendingCancels.filter(body => body.requestId !== request.requestId); latest = result;
    }
    return latest ? { ...latest, accepted: true, acknowledged: true, state: 'cancelled' } : { ok: true, state: 'idle', acknowledged: false };
  }
  async function commitCancel(body = {}) {
    if (!refreshPending() || fatal) return { ...authorityError(fatal), accepted: false, acknowledged: false };
    if (typeof backend?.commitCancel !== 'function') return { ...authorityError(unavailableCode), accepted: false, acknowledged: false };
    if (!store) { fatal = 'PENDING_STORE_UNCONFIGURED'; return { ...authorityError(fatal), accepted: false, acknowledged: false }; }
    if (!pendingCancels.length) {
      const request = bodyFor({ reasonCode: 'owner_cancel', ...body });
      try { store.save(request); }
      catch { fatal = 'PENDING_STORE_UNAVAILABLE'; return { ...authorityError(fatal), accepted: false, acknowledged: false }; }
      pendingCancels.push(request);
    }
    return drainPending();
  }
  return {
    get clientSeenSeq() { return seen; },
    get pendingCancel() { return pendingCancels.length ? structuredClone(pendingCancels[0]) : null; },
    get pendingCancels() { return structuredClone(pendingCancels); },
    commitCancel,
    retryPendingCancels: () => drainPending(),
    async readEpoch() {
      if (!refreshPending()) return authorityError(fatal);
      if (pendingCancels.length) { const result = await drainPending(); if (!result.ok) return result; }
      return call('readEpoch');
    },
    async status() {
      if (!refreshPending()) return authorityError(fatal);
      if (pendingCancels.length) { const result = await drainPending(); if (!result.ok) return result; }
      const result = await call('status');
      return result.cancelled ? { ...result, state: 'cancelled' } : result;
    },
    async casAdmitEffect(body) {
      if (typeof backend?.casAdmitEffect !== 'function') return authorityError(unavailableCode);
      if (!refreshPending()) return authorityError(fatal);
      if (!store) return authorityError('PENDING_STORE_UNCONFIGURED');
      if (pendingCancels.length && body.op !== 'settle') return authorityError('CANCEL_PENDING');
      const result = await call('casAdmitEffect', bodyFor(body));
      if (result.parkReason === 'CAS_CONFLICT') await call('readEpoch');
      if (result.ok && body.op === 'effect' && (result.replayed || result.result?.admitted !== true)) return authorityError('AUTHORITY_UNAVAILABLE', true);
      return result;
    },
  };
}

const canonical = value => JSON.stringify(value, (_key, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
/** In-memory reference backend for tests only; never selected by configuration. */
export function createFakeAuthority({ tenantId, taskId, now = Date.now, snapshot } = {}) {
  let seq = snapshot?.seq ?? 0, epoch = snapshot?.epoch ?? 0, cancelled = snapshot?.cancelled ?? null, lease = snapshot?.lease ?? null;
  const effects = new Map(snapshot?.effects), requests = new Map(snapshot?.requests);
  const envelope = (op, extra = {}) => ({ ok: true, op, tenantId, taskId, seq, epoch,
    cancelled: structuredClone(cancelled), lease: structuredClone(lease),
    unknownEffects: [...effects].filter(([, v]) => ['admitted', 'unknown'].includes(v)).map(([id]) => id), backend: 'remote-do', ...extra });
  const error = (op, code) => envelope(op, { ...authorityError(code), error: { code, message: code, retryable: false } });
  function mutate(op, body) {
    if (body.tenantId !== tenantId || body.taskId !== taskId) return error(op, 'TENANT_MISMATCH');
    if (typeof body.requestId !== 'string' || body.requestId.length < 16) return error(op, 'BAD_REQUEST');
    const hash = createHash('sha256').update(canonical(body)).digest('hex');
    if (requests.has(body.requestId)) {
      const stored = requests.get(body.requestId);
      return stored.hash === hash ? { ...structuredClone(stored.response), replayed: true } : error(op, 'IDEMPOTENCY_MISMATCH');
    }
    let result = {};
    if (op === 'commitCancel') {
      if (!['owner_cancel', 'policy', 'other'].includes(body.reasonCode)) return error(op, 'BAD_REQUEST');
      epoch++;
      cancelled ??= { atSeq: seq + 1, atEpoch: epoch, reasonCode: body.reasonCode, requestId: body.requestId };
    } else {
      if (!['claim', 'effect', 'settle'].includes(body.op)) return error(op, 'BAD_REQUEST');
      if (cancelled && body.op !== 'settle') return error(op, 'CANCELLED');
      if (body.expectedEpoch !== epoch || body.op === 'effect' && body.expectedSeq !== seq) return error(op, 'CAS_CONFLICT');
      if (lease && now() >= lease.expiresAt) { lease = null; return error(op, 'LEASE_EXPIRED'); }
      if (body.op === 'claim') {
        if (!Number.isInteger(body.leaseTtlMs) || body.leaseTtlMs < 1000 || body.leaseTtlMs > 600000) return error(op, 'BAD_REQUEST');
        epoch++; lease = { leaseId: randomUUID(), epoch, expiresAt: now() + body.leaseTtlMs }; result = { leaseId: lease.leaseId };
      } else {
        if (!lease || now() >= lease.expiresAt) return error(op, 'LEASE_EXPIRED');
        if (lease.epoch !== epoch || body.leaseId !== lease.leaseId) return error(op, 'LEASE_EXPIRED');
        if (body.op === 'effect') {
          if ([...effects.values()].some(v => ['admitted', 'unknown'].includes(v))) return error(op, 'UNKNOWN_EFFECT_PENDING');
          if (effects.has(body.effectId) || typeof body.effectId !== 'string' || !/^[a-f0-9]{64}$/.test(body.intentHash ?? '')) return error(op, 'BAD_REQUEST');
          effects.set(body.effectId, 'admitted'); result = { admitted: true, effectId: body.effectId };
        } else {
          if (!effects.has(body.effectId) || !['ok', 'failed', 'unknown'].includes(body.outcome)) return error(op, 'BAD_REQUEST');
          effects.set(body.effectId, body.outcome);
        }
      }
    }
    seq++;
    const response = envelope(op, { requestId: body.requestId, result });
    requests.set(body.requestId, { hash, response: structuredClone(response) });
    return response;
  }
  return { snapshotForTests: () => structuredClone({ seq, epoch, cancelled, lease, effects: [...effects], requests: [...requests] }),
    commitCancel: body => mutate('commitCancel', body), casAdmitEffect: body => mutate('casAdmitEffect', body),
    readEpoch: () => envelope('readEpoch'), status: () => envelope('status', { enabled: true }) };
}
