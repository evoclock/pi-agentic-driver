// Logical ownership never retires or replaces the per-event filesystem writer lock.
const ownerId = /^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/;
export const ownershipOf = s => s.ownership ?? { ownerId: s.writerId, generation: 0, managed: false };
export const staleOwnershipIntent = s => ownershipOf(s).managed && s.intent &&
  (s.intent.writerId !== s.writerId || (s.intent.ownerGeneration ?? 0) !== ownershipOf(s).generation);
const matches = (observed, request) => observed && Object.entries(request).every(([key, value]) => observed[key] === value);

export function ownerObserved(s, adapter) {
  const ownership = ownershipOf(s);
  if (!ownership.managed) return true;
  const request = Object.freeze({ taskDigest: s.contractDigest, ownerId: ownership.ownerId, generation: ownership.generation });
  const observed = typeof adapter.observeOwner === 'function' ? adapter.observeOwner(request) : null;
  return ownership.ownerId !== null && matches(observed, request); // EffectFenceGuard
}

export function ownershipMove(s, event, adapter) {
  const ownership = ownershipOf(s);
  if (['release-ownership', 'transfer-ownership'].includes(event.type)) {
    const transfer = event.type === 'transfer-ownership';
    if (transfer && (!ownerId.test(event.targetOwner ?? '') || event.targetOwner === ownership.ownerId)) throw new Error('invalid ownership target');
    const request = Object.freeze({ taskDigest: s.contractDigest, eventId: event.id,
      type: event.type, ownerId: ownership.ownerId, generation: ownership.generation,
      targetOwner: transfer ? event.targetOwner : null });
    const observed = typeof adapter.ownerControl === 'function' ? adapter.ownerControl(request) : null;
    const approved = observed?.approved === true && matches(observed, request);
    if (!transfer && !approved) throw new Error('owner control unverified'); // ReleaseControlGuard
    if (transfer && !approved) throw new Error('owner control unverified'); // TransferControlGuard
    if (['cancelled', 'done', 'exhausted'].includes(s.phase)) return { move: 'settled', reason: s.phase };
    if (!Number.isSafeInteger(ownership.generation + 1) || !Number.isSafeInteger(s.epoch + 1)) throw new Error('ownership generation exhausted');
    s.ownership = { ownerId: request.targetOwner,
      generation: ownership.generation + 1, managed: true }; // TransferGenerationGuard
    s.epoch++;
    if (transfer) s.writerId = request.targetOwner;
    s.pending = null; s.wake = null;
    if (s.phase !== 'held') s.phase = s.intent || !transfer ? 'parked' : 'ready';
    return { move: 'wait', reason: transfer ? 'ownership-transferred' : 'ownership-released' };
  }
  if (event.type !== 'reconcile-old') return null;
  if (!staleOwnershipIntent(s)) return { move: 'wait', reason: 'old-effect-not-stale' };
  const request = Object.freeze({ taskDigest: s.contractDigest, dispatchId: s.intent.dispatchId,
    writerId: s.intent.writerId, ownerGeneration: s.intent.ownerGeneration ?? 0,
    epoch: s.intent.epoch, branch: s.intent.branch, base: s.intent.base });
  const observed = typeof adapter.reconcileOld === 'function' ? adapter.reconcileOld(request) : null;
  if (!matches(observed, request) || !['absent', 'completed', 'failed'].includes(observed.status))
    return { move: 'wait', reason: 'old-effect-unverified' }; // ReconcileTerminalGuard
  s.intent = null; s.pending = null; s.wake = null;
  if (!['held', 'cancelled', 'done', 'exhausted'].includes(s.phase)) s.phase = ownership.ownerId === null ? 'parked' : 'ready';
  return { move: 'wait', reason: 'old-effect-settled', effectOutcome: observed.status === 'completed' ? 'ok' : 'failed' };
}

export const ownershipReplay = (s, original) => ownershipOf(s).managed && ['act', 'advance'].includes(original.move)
  ? { move: 'wait', reason: 'ownership-replay-not-dispatch', authorityCreated: false, duplicate: true }
  : null;
