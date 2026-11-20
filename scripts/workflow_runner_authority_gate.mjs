import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';

export const thenResult = (value, next) => value && typeof value.then === 'function' ? value.then(next) : next(value);
export const parkAuthority = (reason, extra = {}) => ({ move: 'wait', phase: 'parked', reason, authorityCreated: false, ...extra });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function retainWriter(callback, release) {
  let result;
  try { result = callback(); } catch (error) { release(); throw error; }
  if (result && typeof result.then === 'function') return result.finally(release);
  release(); return result;
}

/** Local metadata is only a cache/high-water detector, never an admission. */
export function authorityGate(authority, store, repo) {
  const cacheRoot = join(dirname(store), '.authority-cache');
  const file = join(cacheRoot, `${hash(store)}.json`);
  let cache = { seq: 0, epoch: 0, pendingCancel: null }, failed = null;
  const hadCache = existsSync(file);
  try {
    if (existsSync(file)) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { cache = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
      if (!Number.isSafeInteger(cache.seq) || cache.seq < 0) failed = 'STALE_AUTHORITY';
    }
  } catch { failed = 'STALE_AUTHORITY'; }
  function save() {
    for (const path of [join(repo, '.local'), dirname(store), cacheRoot]) {
      mkdirSync(path, { recursive: true });
      if (realpathSync(path) !== path) throw new Error('unsafe authority cache path');
    }
    const temp = join(cacheRoot, `.authority-${randomUUID()}`);
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(cache)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const dir = openSync(cacheRoot, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  function call(method, body) {
    if (failed) return { ok: false, error: { code: failed } };
    if (typeof authority?.[method] !== 'function') return { ok: false, error: { code: 'AUTHORITY_UNCONFIGURED' } };
    const accept = response => {
      if (!response || typeof response.ok !== 'boolean') return { ok: false, error: { code: 'AUTHORITY_UNAVAILABLE' } };
      if (Number.isSafeInteger(response.seq)) {
        const previous = JSON.stringify(cache);
        if (response.seq < cache.seq && (method === 'readEpoch' || !response.replayed)) {
          failed = 'STALE_AUTHORITY'; return { ok: false, error: { code: failed } };
        }
        if (method === 'readEpoch' && (response.epoch > (cache.epoch ?? 0) || !hadCache && response.seq > 0)) cache.reconciliationRequired = true;
        cache.seq = Math.max(cache.seq, response.seq);
        cache.epoch = Math.max(cache.epoch ?? 0, response.epoch ?? 0);
        if (!existsSync(file) || JSON.stringify(cache) !== previous) save();
      } else if (response.ok) return { ok: false, error: { code: 'AUTHORITY_UNAVAILABLE' } };
      return response;
    };
    try {
      const result = authority[method](body);
      return result && typeof result.then === 'function' ? result.then(accept, () => ({ ok: false, error: { code: 'AUTHORITY_UNAVAILABLE' } })) : accept(result);
    } catch { return { ok: false, error: { code: 'AUTHORITY_UNAVAILABLE' } }; }
  }
  const blocked = response => parkAuthority(response.parkReason ?? response.error?.code ?? 'AUTHORITY_UNAVAILABLE',
    response.state === 'cancel_pending' ? { phase: 'cancel_pending', acknowledged: false } : {});
  const cancelled = () => ({ move: 'settled', phase: 'cancelled', reason: 'cancelled', acknowledged: true, authorityCreated: false });
  const request = (view, body) => ({ tenantId: view.tenantId, taskId: view.taskId, clientSeenSeq: cache.seq, requestId: randomUUID(), ...body });
  function commit(view, event, next) {
    cache.pendingCancel ??= request(view, { reasonCode: 'owner_cancel' }); save();
    return thenResult(call('commitCancel', cache.pendingCancel), result => {
      if (!result.ok) return blocked(result).reason === 'STALE_AUTHORITY' ? blocked(result)
        : parkAuthority(result.error?.code ?? result.parkReason, { phase: 'cancel_pending', acknowledged: false });
      cache.pendingCancel = null; save();
      return event.type === 'cancel' ? next() : cancelled();
    });
  }
  return {
    start(event, next) {
      return thenResult(call('readEpoch'), view => {
        if (!view.ok) return event.type === 'cancel' && view.error?.code === 'AUTHORITY_UNAVAILABLE'
          ? commit(view, event, next) : blocked(view);
        if (view.cancelled) {
          cache.pendingCancel = null; save();
          if (event.type === 'status') return cancelled();
          return thenResult(next(), result => result.reconciliationRequired || ['cancelled', 'done', 'held', 'exhausted'].includes(result.phase)
            ? result : cancelled());
        }
        if (event.type === 'cancel' || cache.pendingCancel) return commit(view, event, next);
        if (cache.reconciliationRequired) return parkAuthority('AUTHORITY_RECONCILIATION_REQUIRED');
        return next();
      });
    },
    beforePersist(output, previous) {
      return thenResult(call('readEpoch'), view => {
        if (!view.ok) return blocked(view);
        if (view.cancelled) return ['cancelled', 'done', 'held', 'exhausted'].includes(output.state.phase) ? null : cancelled();
        if (cache.reconciliationRequired) return parkAuthority('AUTHORITY_RECONCILIATION_REQUIRED');
        const unresolved = view.unknownEffects ?? [];
        if (output.result.move === 'advance' && unresolved.length) return parkAuthority('UNKNOWN_EFFECT_PENDING');
        const settled = ['verified-receipt', 'effect-confirmed-absent', 'old-effect-settled'].includes(output.result.reason);
        if (settled && previous.intent) {
          const effectId = hash(previous.intent.dispatchId);
          if (!unresolved.includes(effectId)) return null;
          return thenResult(call('casAdmitEffect', request(view, { op: 'settle', expectedEpoch: view.epoch,
            leaseId: view.lease?.leaseId, effectId, outcome: output.result.effectOutcome ?? (output.result.reason === 'verified-receipt' ? 'ok' : 'failed'), evidenceHash: hash(output.result) })), result => result.ok ? null : blocked(result));
        }
        if (output.result.move !== 'act') return null;
        if (unresolved.length) return parkAuthority('UNKNOWN_EFFECT_PENDING');
        return thenResult(call('casAdmitEffect', request(view, { op: 'claim', expectedEpoch: view.epoch, leaseTtlMs: 600000 })), claim => {
          if (!claim.ok) return blocked(claim);
          return thenResult(call('casAdmitEffect', request(claim, { op: 'effect', expectedEpoch: claim.epoch,
            expectedSeq: claim.seq, leaseId: claim.lease?.leaseId ?? claim.result?.leaseId,
            effectId: hash(output.state.intent.dispatchId), intentHash: hash(output.state.intent) })), result => {
            if (!result.ok) return blocked(result);
            if (result.replayed || result.result?.admitted !== true) return parkAuthority('UNKNOWN_EFFECT_PENDING');
            return null;
          });
        });
      });
    },
  };
}
