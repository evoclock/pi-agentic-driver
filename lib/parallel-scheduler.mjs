import { matchesGlob } from 'node:path';

const safePath = value => typeof value === 'string' && value.length > 0 &&
  !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
  value.split('/').every(part => part && part !== '.' && part !== '..');
const list = value => Array.isArray(value) && value.every(x => typeof x === 'string' && x.length > 0);

/** Manifest lint is also the constructor boundary: no undeclared write sets. */
export function validateManifest(tasks) {
  if (!Array.isArray(tasks)) throw new Error('task manifest must be an array');
  const ids = new Set();
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(t.id) || ids.has(t.id))
      throw new Error('invalid or duplicate task id');
    ids.add(t.id);
    if (!list(t.touches) || !t.touches.length || !t.touches.every(safePath))
      throw new Error(`task ${t.id} requires nonempty relative touches`);
    if (!list(t.dependsOn) || !list(t.resources)) throw new Error('dependsOn and resources must be explicit arrays');
  }
  const byId = new Map(tasks.map(t => [t.id, t]));
  const seen = new Set(), visiting = new Set();
  function visit(id) {
    if (!ids.has(id)) throw new Error(`unknown dependency ${id}`);
    if (visiting.has(id)) throw new Error('dependency cycle');
    if (seen.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependsOn) visit(dep);
    visiting.delete(id); seen.add(id);
  }
  for (const id of ids) visit(id);
  return tasks;
}

// Prefix approximation deliberately over-serializes wildcard sets. It never
// declares two sets independent merely because their spelling is different.
export function touchesOverlap(a, b) {
  const prefix = pattern => pattern.toLowerCase().split(/[*?\[\]{}()!+@]/, 1)[0];
  const x = prefix(a), y = prefix(b);
  return x.startsWith(y) || y.startsWith(x);
}
function conflict(a, b) {
  return a.resources.some(r => b.resources.includes(r)) ||
    a.touches.some(x => b.touches.some(y => touchesOverlap(x, y)));
}

/** G8 integration seam. Call on both sides of a rename; paths are repo-relative. */
export function checkDeclaredTouches(task, changedPaths) {
  validateManifest([{ ...task, dependsOn: [] }]);
  if (!Array.isArray(changedPaths)) throw new Error('changed paths must be an array');
  const undeclared = changedPaths.filter(path => !safePath(path) ||
    !task.touches.some(pattern => matchesGlob(path, pattern)));
  return { ok: undeclared.length === 0, undeclared };
}
export function requireG8TouchGate(integration) {
  if (integration?.checkDeclaredTouches !== checkDeclaredTouches)
    throw new Error('G8 declared-touch gate is not wired');
  return integration.checkDeclaredTouches;
}

/**
 * Single-owner in-memory scheduler. Ports are trusted host adapters, not worker
 * assertions. acquire returns null on pool exhaustion, never a copied checkout;
 * merged verifies the exact task PR/head; release conditionally returns its lease.
 * A dispatch error retains the reservation (possibly delivered, never replayed).
 * Restart recovery and a durable host owner are required before unattended use.
 */
export class ParallelScheduler {
  #tasks; #ports; #tail = Promise.resolve();
  constructor(tasks, ports) {
    validateManifest(tasks);
    if (!Number.isSafeInteger(ports.cap) || ports.cap < 1) throw new Error('invalid slot cap');
    for (const name of ['acquire', 'release', 'dispatch', 'merged', 'report'])
      if (typeof ports[name] !== 'function') throw new Error(`missing ${name} port`);
    this.#tasks = structuredClone(tasks).map(t => ({ ...t, resources: t.resources.map(r => r.toLowerCase()), state: 'queued', lease: null }));
    this.#ports = ports;
  }
  #serial(action) {
    const result = this.#tail.then(action);
    this.#tail = result.catch(() => {});
    return result;
  }
  snapshot() { return structuredClone(this.#tasks); }
  tick() { return this.#serial(async () => {
    const active = this.#tasks.filter(t => t.state === 'running');
    const merged = new Set(this.#tasks.filter(t => t.state === 'merged').map(t => t.id));
    const dispatches = [], loopErrors = [];
    let unrecorded = null;
    try {
      for (const t of this.#tasks) {
        if (t.state !== 'queued' || !t.dependsOn.every(id => merged.has(id)) || active.some(u => conflict(t, u))) continue;
        if (active.length >= this.#ports.cap) {
          this.#ports.report({ task: t.id, status: 'waiting-for-slot' }); continue;
        }
        const lease = await this.#ports.acquire(structuredClone(t));
        if (lease === null) { this.#ports.report({ task: t.id, status: 'waiting-for-slot' }); break; }
        unrecorded = { task: t.id, lease };
        if (typeof lease?.id !== 'string' || !lease.id || typeof lease.path !== 'string' || !lease.path ||
            active.some(u => u.lease.id === lease.id || u.lease.path === lease.path))
          throw new Error('invalid or duplicate Treehouse lease; operator recovery required');
        t.lease = structuredClone(lease); t.state = 'running'; active.push(t);
        unrecorded = null;
        // Start every selected stream, but drain all deliveries even if the loop fails later.
        dispatches.push(Promise.resolve().then(() => this.#ports.dispatch(structuredClone(t), structuredClone(lease)))
          .then(() => ({ ok: true }), error => ({ ok: false, error })));
      }
    } catch (error) {
      loopErrors.push(error);
      if (unrecorded) {
        const leaseId = typeof unrecorded.lease?.id === 'string' ? unrecorded.lease.id : '<missing or invalid>';
        loopErrors.push(new Error(`unrecorded Treehouse lease id ${leaseId}; inspect before retry`, { cause: error }));
        try { this.#ports.report({ task: unrecorded.task, status: 'unrecorded-lease', leaseId }); }
        catch (reportError) { loopErrors.push(reportError); }
      }
    } finally {
      const results = await Promise.all(dispatches);
      const failures = [...loopErrors, ...results.filter(r => !r.ok).map(r => r.error)];
      if (failures.length) throw new AggregateError(failures, 'tick failed; reservations held, inspect before retry');
    }
    return this.snapshot();
  }); }
  merge(id) { return this.#serial(async () => {
    const t = this.#tasks.find(t => t.id === id);
    if (!t || t.state !== 'running') throw new Error('merge requires a running task');
    if (!await this.#ports.merged(structuredClone(t))) throw new Error('merge not verified');
    // Publish merged only after conditional return succeeds; dependent work waits
    // visibly if Treehouse refuses a dirty, active or changed lease.
    await this.#ports.release(structuredClone(t.lease), structuredClone(t));
    t.lease = null; t.state = 'merged';
    return this.snapshot();
  }); }
  /** Explicit host/owner action only; never inferred from a missing or unmerged PR. */
  abandon(id) { return this.#serial(async () => {
    const t = this.#tasks.find(t => t.id === id);
    if (!t || t.state !== 'running') throw new Error('abandon requires a running task');
    if (typeof this.#ports.closed !== 'function' || !await this.#ports.closed(structuredClone(t)))
      throw new Error('closed unmerged PR not verified');
    await this.#ports.release(structuredClone(t.lease), structuredClone(t), 'abandoned');
    t.lease = null; t.state = 'abandoned';
    return this.snapshot();
  }); }
}
