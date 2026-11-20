import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteAuthority } from '../scripts/workflow_runner_authority_remote.mjs';
const raw = await import('../scripts/workflow_runner_authority.mjs').catch(() => ({}));
const stateDirs = [];
function stateDir() { const path = mkdtempSync(join(tmpdir(), 'pending-cancel-')); stateDirs.push(path); return path; }
after(() => { for (const path of stateDirs) rmSync(path, { recursive: true, force: true }); });
const mod = { ...raw, createAuthorityClient: options => raw.createAuthorityClient({ stateDir: stateDir(), ...options }) };
const ids = { tenantId: 'tenant_0001', taskId: 'task_000001' };
function fixture(options = {}) {
  assert.equal(typeof mod.createFakeAuthority, 'function', 'shared authority interface exists');
  const backend = mod.createFakeAuthority({ ...ids, ...options });
  return { backend, client: mod.createAuthorityClient({ ...ids, backend }) };
}
const unavailable = () => ({ ok: false, error: { code: 'AUTHORITY_UNAVAILABLE', retryable: true } });

// Why: a local cancel is not an acknowledgement until the protected authority commits.
test('cancel acknowledgement follows durable commit', async () => {
  const { backend, client } = fixture();
  const result = await client.commitCancel({ reasonCode: 'owner_cancel' });
  assert.equal(result.acknowledged, true);
  assert.ok((await backend.readEpoch()).cancelled);
  assert.equal(result.seq, 1);
});
// Why: disconnected cancel must remain visibly pending and retain its immutable request body.
test('offline cancel stays pending and retries the same requestId', async () => {
  const { backend } = fixture(); const seen = []; let offline = true;
  const client = mod.createAuthorityClient({ ...ids, backend: { ...backend, commitCancel: async body => {
    seen.push(structuredClone(body)); return offline ? unavailable() : backend.commitCancel(body);
  } } });
  const pending = await client.commitCancel({ reasonCode: 'owner_cancel' });
  assert.equal(pending.state, 'cancel_pending'); assert.equal(pending.acknowledged, false);
  assert.equal((await client.casAdmitEffect({ op: 'claim', expectedEpoch: 0 })).parkReason, 'CANCEL_PENDING');
  offline = false; assert.equal((await client.commitCancel({ reasonCode: 'owner_cancel' })).acknowledged, true);
  assert.deepEqual(seen[0], seen[1]);
});
// Why: a committed cancel with a lost response must not commit twice on retry.
test('lost cancel reply replays the original result', async () => {
  const { backend } = fixture(); let first = true;
  const client = mod.createAuthorityClient({ ...ids, backend: { ...backend, commitCancel: async body => {
    const result = await backend.commitCancel(body); if (first) { first = false; return unavailable(); } return result;
  } } });
  await client.commitCancel({ reasonCode: 'owner_cancel' });
  const result = await client.commitCancel({ reasonCode: 'owner_cancel' });
  assert.equal(result.replayed, true); assert.equal(result.seq, 1);
});
// Why: CAS conflicts require a fresh observation, never a blind admission retry.
test('CAS conflict parks and re-reads epoch', async () => {
  const { backend, client } = fixture(); let reads = 0;
  const other = mod.createAuthorityClient({ ...ids, backend });
  await other.casAdmitEffect({ op: 'claim', expectedEpoch: 0, leaseTtlMs: 1000 });
  const original = backend.readEpoch; backend.readEpoch = async () => { reads++; return original(); };
  const result = await client.casAdmitEffect({ op: 'claim', expectedEpoch: 0, leaseTtlMs: 1000 });
  assert.equal(result.parkReason, 'CAS_CONFLICT'); assert.equal(reads, 1);
  assert.equal((await backend.readEpoch()).seq, 1);
});
// Why: uncertain physical effects cannot be bypassed by another admission.
test('unknown effect blocks the next effect until trusted settlement', async () => {
  const { client } = fixture();
  const claim = await client.casAdmitEffect({ op: 'claim', expectedEpoch: 0, leaseTtlMs: 1000 });
  const body = { expectedEpoch: claim.epoch, leaseId: claim.lease.leaseId };
  const effect = await client.casAdmitEffect({ ...body, op: 'effect', expectedSeq: claim.seq, effectId: 'effect01', intentHash: 'a'.repeat(64) });
  const result = await client.casAdmitEffect({ ...body, op: 'effect', expectedSeq: effect.seq, effectId: 'effect02', intentHash: 'b'.repeat(64) });
  assert.equal(result.parkReason, 'UNKNOWN_EFFECT_PENDING');
});
// Why: lease expiry is an admission-time check even when no alarm runs.
test('expired lease is rejected lazily', async () => {
  let now = 0; const { client } = fixture({ now: () => now });
  const claim = await client.casAdmitEffect({ op: 'claim', expectedEpoch: 0, leaseTtlMs: 1000 }); now = 1000;
  const result = await client.casAdmitEffect({ op: 'effect', expectedEpoch: claim.epoch, expectedSeq: claim.seq,
    leaseId: claim.lease.leaseId, effectId: 'effect01', intentHash: 'a'.repeat(64) });
  assert.equal(result.parkReason, 'LEASE_EXPIRED');
});
// Why: even a competing claim must observe an expired lease before it can reclaim.
test('claim checks lazy lease expiry without an alarm', async () => {
  let now = 0; const { client } = fixture({ now: () => now });
  const claimed = await client.casAdmitEffect({ op: 'claim', expectedEpoch: 0, leaseTtlMs: 1000 }); now = 1000;
  assert.equal((await client.casAdmitEffect({ op: 'claim', expectedEpoch: claimed.epoch, leaseTtlMs: 1000 })).parkReason, 'LEASE_EXPIRED');
});

// Why: the model-derived rollback trace must leave the separately protected cancel intact.

test('G4 acknowledged cancel survives deleting checkpoint and truncating journal', async () => {
  const { backend, client } = fixture(); const cache = { checkpoint: {}, journal: [] };
  await client.commitCancel({ reasonCode: 'owner_cancel' }); cache.journal.push('cancel');
  delete cache.checkpoint; cache.journal.length = 0;
  const restarted = mod.createAuthorityClient({ ...ids, backend });
  assert.ok((await restarted.readEpoch()).cancelled);
  assert.equal((await restarted.casAdmitEffect({ op: 'claim', expectedEpoch: 0, leaseTtlMs: 1000 })).parkReason, 'CANCELLED');
});
// Why: a server rollback below an observed high-water mark is not a usable authority.
test('STALE_AUTHORITY parks on lower seq', async () => {
  const { client } = fixture();
  const stale = mod.createAuthorityClient({ ...ids, backend: { readEpoch: async () => ({ ok: true, seq: 0, epoch: 0 }) }, clientSeenSeq: 2 });
  assert.equal((await stale.readEpoch()).parkReason, 'STALE_AUTHORITY');
  assert.equal(typeof client.status, 'function');
});
// Why: absence of a protected authority must never silently enable local-only execution.
test('no configured authority parks', async () => {
  fixture(); const client = mod.createAuthorityClient(ids);
  assert.equal((await client.readEpoch()).parkReason, 'AUTHORITY_UNCONFIGURED');
  assert.equal((await client.casAdmitEffect({ op: 'claim' })).ok, false);
});
// Why: replaying a requestId with changed content is a bug, not a new operation.
test('IDEMPOTENCY_MISMATCH parks', async () => {
  const { client } = fixture(); const requestId = '00000000-0000-4000-8000-000000000001';
  await client.commitCancel({ requestId, reasonCode: 'owner_cancel' });
  assert.equal((await client.commitCancel({ requestId, reasonCode: 'policy' })).parkReason, 'IDEMPOTENCY_MISMATCH');
});
// Why: the local backend extension point must fail closed before its implementation exists.
test('local daemon loader and config kinds are explicit', async () => {
  fixture(); assert.equal(mod.parseAuthorityConfig({ kind: 'remote-do', ...ids }).kind, 'remote-do');
  const client = await mod.loadAuthority({ kind: 'local-daemon', ...ids }, { localLoader: async () => ({}) });
  assert.equal((await client.readEpoch()).parkReason, 'BACKEND_NOT_IMPLEMENTED');
});
// Why: status is observation, not admission, and must expose backend health.
test('status exposes backend and committed sequence', async () => {
  const { client } = fixture(); await client.commitCancel({ reasonCode: 'owner_cancel' });
  const status = await client.status(); assert.equal(status.enabled, true); assert.equal(status.seq, 1);
});

// Why: accepting a cancel without a durable queue must not submit or promise restart survival.
test('cancel without a durable pending store is not accepted', async () => {
  const { backend } = fixture(); let calls = 0;
  const client = mod.createAuthorityClient({ ...ids, stateDir: undefined, backend: { ...backend, commitCancel: body => { calls++; return backend.commitCancel(body); } } });
  const result = await client.commitCancel({ reasonCode: 'owner_cancel' });
  assert.equal(result.accepted, false); assert.equal(result.acknowledged, false); assert.equal(calls, 0);
});

// Why: failure to persist an owner intent must fail before transport, not downgrade to volatile pending state.
test('pending-store write failure prevents cancel submission', async () => {
  const { backend } = fixture(); const path = join(stateDir(), 'not-a-directory'); writeFileSync(path, 'synthetic'); let calls = 0;
  const client = mod.createAuthorityClient({ ...ids, stateDir: path, backend: { ...backend, commitCancel: body => { calls++; return backend.commitCancel(body); } } });
  const result = await client.commitCancel({ reasonCode: 'owner_cancel' });
  assert.equal(result.parkReason, 'PENDING_STORE_UNAVAILABLE'); assert.equal(result.accepted, false); assert.equal(calls, 0);
});

// Why: tenant mapping is an authority decision, never inferred from caller-controlled path fields.
test('fake authority rejects a foreign tenant and the client parks without retry', async () => {
  const { backend } = fixture(); let calls = 0;
  const client = mod.createAuthorityClient({ tenantId: 'tenant_0002', taskId: ids.taskId, backend: { ...backend, commitCancel: body => { calls++; return backend.commitCancel(body); } } });
  assert.equal((await client.commitCancel({ reasonCode: 'owner_cancel' })).parkReason, 'TENANT_MISMATCH');
  assert.equal((await client.commitCancel({ reasonCode: 'owner_cancel' })).parkReason, 'TENANT_MISMATCH'); assert.equal(calls, 1);
});

// Why: the same restart contract must hold above both the fake and HTTP backend, independently of transport retries.
for (const kind of ['fake', 'remote-do']) {
  test(`pending cancel survives client restart with original requestId (${kind})`, async () => {
    const dir = stateDir(), fake = mod.createFakeAuthority(ids); let offline = true, admissions = 0;
    const submitted = [], persistedBeforeSubmit = []; let backend;
    const dispatch = async (op, body) => {
      if (op === 'commitCancel') {
        submitted.push(structuredClone(body));
        const recovered = mod.createAuthorityClient({ ...ids, backend, stateDir: dir });
        persistedBeforeSubmit.push(recovered.pendingCancel?.requestId === body.requestId);
      }
      if (op === 'casAdmitEffect') admissions++;
      return offline ? unavailable() : fake[op](body);
    };
    backend = kind === 'fake'
      ? Object.fromEntries(['commitCancel', 'casAdmitEffect', 'readEpoch', 'status'].map(op => [op, body => dispatch(op, body)]))
      : createRemoteAuthority({ ...ids, baseUrl: 'https://authority.invalid', authHeaders: async () => ({}),
          fetch: async (url, init) => {
            const op = { cancel: 'commitCancel', admit: 'casAdmitEffect', epoch: 'readEpoch', status: 'status' }[new URL(url).pathname.split('/').at(-1)];
            const result = await dispatch(op, init.body ? JSON.parse(init.body) : undefined);
            return new Response(offline ? null : JSON.stringify(result), { status: offline ? 503 : result.ok ? 200 : 409 });
          } });
    const first = mod.createAuthorityClient({ ...ids, backend, stateDir: dir });
    const pending = await first.commitCancel({ reasonCode: 'owner_cancel' });
    assert.equal(pending.state, 'cancel_pending'); assert.equal(pending.acknowledged, false);
    const original = structuredClone(submitted[0]); assert.ok(original.requestId);
    const restarted = mod.createAuthorityClient({ ...ids, backend, stateDir: dir });
    assert.equal((await restarted.status()).state, 'cancel_pending');
    assert.equal(restarted.pendingCancel.requestId, original.requestId);
    assert.equal((await restarted.casAdmitEffect({ op: 'claim', expectedEpoch: 0, leaseTtlMs: 1000 })).parkReason, 'CANCEL_PENDING');
    assert.equal(admissions, 0);
    offline = false;
    const acknowledged = await restarted.commitCancel({ reasonCode: 'owner_cancel' });
    assert.equal(acknowledged.acknowledged, true); assert.equal(acknowledged.requestId, original.requestId);
    assert.ok(submitted.every(body => JSON.stringify(body) === JSON.stringify(original)));
    assert.ok(persistedBeforeSubmit.every(Boolean), 'pending request is recoverable before the first transport attempt');
    const final = mod.createAuthorityClient({ ...ids, backend, stateDir: dir });
    assert.equal(final.pendingCancel, null); assert.ok((await final.readEpoch()).cancelled);
  });
}
