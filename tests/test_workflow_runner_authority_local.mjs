import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function fixture(t, options = {}) {
  await mkdir('.scratch', { recursive: true });
  const dir = await mkdtemp(resolve('.scratch/authority-'));
  let daemon;
  t.after(async () => { await daemon?.close(); await rm(dir, { recursive: true, force: true }); });
  const module = await import('../scripts/pad-authority-daemon.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.startAuthorityDaemon, 'function', 'local authority daemon must exist');
  const config = { stateDir: join(dir, 'state'), socketPath: join(dir, 'socket'), tenantByUid: { [process.getuid()]: 'tenant001' }, ...options };
  const start = async () => { daemon = await module.startAuthorityDaemon(config); };
  const stop = async () => { if (daemon) { await daemon.close(); daemon = null; } };
  await start();
  return { config, directory: join(config.stateDir, 'tenant001.task0001'), start, stop,
    async restart() { await stop(); await start(); },
    call: request => new Promise((accept, reject) => {
      const socket = net.createConnection(relative(process.cwd(), config.socketPath));
      socket.setTimeout(2000, () => socket.destroy(new Error('socket timeout')));
      socket.once('error', reject);
      let response = '';
      socket.once('end', () => { if (!response.includes('\n')) reject(new Error('unavailable')); });
      socket.on('data', chunk => {
        response += chunk;
        if (response.includes('\n')) {
          socket.end();
          try { accept(JSON.parse(response.split('\n')[0])); } catch (error) { reject(error); }
        }
      });
      socket.once('connect', () => socket.write(`${JSON.stringify({ tenantId: 'tenant001', taskId: 'task0001', ...request })}\n`));
    }),
  };
}
const cancel = (requestId = randomUUID()) => ({ op: 'commitCancel', body: { requestId, reasonCode: 'owner_cancel', clientSeenSeq: 0 } });
const claim = (epoch = 0) => ({ op: 'casAdmitEffect', body: { op: 'claim', requestId: randomUUID(), expectedEpoch: epoch, leaseTtlMs: 1000, clientSeenSeq: 0 } });
const effect = state => ({ op: 'casAdmitEffect', body: { op: 'effect', requestId: randomUUID(), expectedEpoch: state.epoch, expectedSeq: state.seq, leaseId: state.lease.leaseId, effectId: 'effect001', intentHash: 'a'.repeat(64), clientSeenSeq: state.seq } });

// Why: a socket caller cannot select a different tenant by changing JSON.
test('kernel peer identity fences tenant selection', async t => {
  const { call } = await fixture(t);
  const response = await call({ op: 'readEpoch', tenantId: 'tenant002' });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'TENANT_MISMATCH');
  const nested = cancel();
  nested.body.tenantId = 'tenant002';
  assert.equal((await call(nested)).error?.code, 'TENANT_MISMATCH');
  assert.equal((await call({ op: 'readEpoch' })).seq, 0);
});

// Why: an unmapped kernel uid has no authority even when its tenant string is valid.
test('unmapped socket peer is refused', async t => {
  const { call } = await fixture(t, { tenantByUid: {} });
  assert.equal((await call({ op: 'readEpoch' })).error.code, 'UNAUTHENTICATED');
});

// Why: acknowledged cancellation must remain authoritative on every later claim.
test('cancel is sticky and replay is idempotent', async t => {
  const { call } = await fixture(t);
  const request = cancel();
  const first = await call(request);
  assert.equal(first.ok, true);
  assert.deepEqual(await call(request), { ...first, replayed: true });
  const mismatch = await call({ ...request, body: { ...request.body, reasonCode: 'policy' } });
  assert.equal(mismatch.error.code, 'IDEMPOTENCY_MISMATCH');
  assert.equal((await call(claim(first.epoch))).error.code, 'CANCELLED');
});

// Why: retrying a lost cancel reply after restart must not mutate twice.
test('duplicate cancel after daemon restart returns original result', async t => {
  const { call, restart } = await fixture(t);
  const request = cancel();
  const first = await call(request);
  assert.equal(first.ok, true);
  await restart();
  assert.deepEqual(await call(request), { ...first, replayed: true });
  const current = await call({ op: 'readEpoch' });
  assert.equal(current.seq, first.seq);
  assert.equal(current.epoch, first.epoch);
});

// Why: an acknowledged mutation survives restart without lowering either fence.
test('epoch and sequence never decrease across restart', async t => {
  const { call, restart } = await fixture(t);
  const first = await call(claim());
  assert.equal(first.ok, true);
  await restart();
  assert.equal((await call(claim(first.epoch))).error?.code, 'LEASE_EXPIRED');
  const second = await call(claim(first.epoch));
  assert.equal(second.ok, true);
  assert.ok(second.seq > first.seq);
  assert.ok(second.epoch > first.epoch);
});

// Why: bytes written before fsync cannot become acknowledged state during recovery.
test('fault between append and fsync does not expose unacknowledged mutation', async t => {
  let fail = false;
  const { call, restart } = await fixture(t, { fault: stage => { if (fail && stage === 'afterWrite') throw new Error('simulated power loss'); } });
  const committed = await call(claim());
  assert.equal(committed.ok, true);
  fail = true;
  await assert.rejects(call(cancel()));
  fail = false;
  await restart();
  const current = await call({ op: 'readEpoch' });
  assert.equal(current.seq, committed.seq);
  assert.equal(current.cancelled, null);
});

// Why: a torn tail was never acknowledged and must not hide earlier durable state.
test('torn tail is discarded at restart', async t => {
  const { call, stop, start, directory } = await fixture(t);
  const first = await call(cancel());
  assert.equal(first.ok, true);
  await stop();
  const path = join(directory, 'records.jsonl');
  await writeFile(path, `${await readFile(path, 'utf8')}{"torn":`);
  await start();
  assert.equal((await call({ op: 'readEpoch' })).seq, first.seq);
  assert.ok((await readFile(path, 'utf8')).endsWith('\n'));
});

// Why: independently retained high-water marks detect rollback of committed records.
test('rollback below high-water mark refuses admission', async t => {
  const { call, stop, start, directory } = await fixture(t);
  const first = await call(claim());
  assert.equal(first.ok, true);
  await stop();
  await writeFile(join(directory, 'records.jsonl'), '');
  await writeFile(join(directory, 'snapshot.json'), JSON.stringify({ seq: 0, epoch: 0 }));
  await start();
  assert.equal((await call(claim())).error.code, 'STALE_AUTHORITY');
});

// Why: lease expiry must be checked without depending on a scheduled alarm.
test('lazy expiry refuses an effect', async t => {
  let time = 10000;
  const { call } = await fixture(t, { now: () => time });
  const state = await call(claim());
  assert.equal(state.ok, true);
  time += 1000;
  assert.equal((await call(effect(state))).error.code, 'LEASE_EXPIRED');
});

// Why: an expired lease must be observed and refused before a fresh claim can replace it.
test('expired claim returns LEASE_EXPIRED before reclaim', async t => {
  let time = 10000;
  const { call } = await fixture(t, { now: () => time });
  const first = await call(claim());
  assert.equal(first.ok, true);
  time += 1000;
  const refused = await call(claim(first.epoch));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'LEASE_EXPIRED');
  assert.equal(refused.seq, first.seq);
  const reclaimed = await call(claim(first.epoch));
  assert.equal(reclaimed.ok, true);
  assert.ok(reclaimed.epoch > first.epoch);
});

// Why: an unreachable socket cannot erase an accepted owner cancel when the client restarts.
test('pending cancel survives client restart with original requestId (local-daemon)', async t => {
  const f = await fixture(t);
  const { createLocalAuthority } = await import('../scripts/workflow_runner_authority_local.mjs');
  const { createAuthorityClient } = await import('../scripts/workflow_runner_authority.mjs');
  const ids = { tenantId: 'tenant001', taskId: 'task0001' };
  const transport = createLocalAuthority({ ...ids, socketPath: f.config.socketPath });
  const stateDir = join(f.config.stateDir, '..', 'client');
  let admissions = 0;
  const submitted = [], persistedBeforeSubmit = [];
  const backend = { ...transport,
    commitCancel(body) {
      submitted.push(structuredClone(body));
      const recovered = createAuthorityClient({ ...ids, stateDir, backend });
      persistedBeforeSubmit.push(recovered.pendingCancel?.requestId === body.requestId);
      return transport.commitCancel(body);
    },
    casAdmitEffect(body) { admissions++; return transport.casAdmitEffect(body); },
  };
  await f.stop();
  const first = createAuthorityClient({ ...ids, stateDir, backend });
  const pending = await first.commitCancel({ reasonCode: 'owner_cancel' });
  assert.equal(pending.accepted, true);
  assert.equal(pending.acknowledged, false);
  assert.equal(pending.state, 'cancel_pending');
  const original = structuredClone(submitted[0]);
  const restarted = createAuthorityClient({ ...ids, stateDir, backend });
  assert.equal((await restarted.status()).state, 'cancel_pending');
  assert.equal(restarted.pendingCancel.requestId, original.requestId);
  assert.equal((await restarted.casAdmitEffect(claim().body)).parkReason, 'CANCEL_PENDING');
  assert.equal(admissions, 0);
  await f.start();
  const acknowledged = await restarted.commitCancel();
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(acknowledged.requestId, original.requestId);
  assert.ok(submitted.every(body => JSON.stringify(body) === JSON.stringify(original)));
  assert.ok(persistedBeforeSubmit.every(Boolean));
  const final = createAuthorityClient({ ...ids, stateDir, backend });
  assert.equal(final.pendingCancel, null);
  assert.ok((await final.readEpoch()).cancelled);
});

// Why: a pre-restart lease cannot authorize new effects in the next daemon generation.
test('restart expires prior leases', async t => {
  const { call, restart } = await fixture(t);
  const state = await call(claim());
  assert.equal(state.ok, true);
  await restart();
  assert.equal((await call(effect(state))).error.code, 'LEASE_EXPIRED');
});

// Why: an outdated contender must not win a compare-and-set race.
test('CAS conflict does not advance committed state', async t => {
  const { call } = await fixture(t);
  const first = await call(claim());
  assert.equal(first.ok, true);
  const conflict = await call(claim());
  assert.equal(conflict.error.code, 'CAS_CONFLICT');
  assert.equal(conflict.seq, first.seq);
});

// Why: uncertain external effects require trusted settlement before the next effect.
test('unknown effect blocks subsequent admission', async t => {
  const { call } = await fixture(t);
  const state = await call(claim());
  const admitted = await call(effect(state));
  assert.equal(admitted.result.admitted, true);
  const settle = { op: 'casAdmitEffect', body: { op: 'settle', requestId: randomUUID(), expectedEpoch: state.epoch, leaseId: state.lease.leaseId, effectId: 'effect001', outcome: 'unknown', evidenceHash: 'b'.repeat(64) } };
  const unknown = await call(settle);
  assert.equal(unknown.ok, true);
  const next = effect({ ...unknown, lease: state.lease });
  next.body.effectId = 'effect002';
  assert.equal((await call(next)).error.code, 'UNKNOWN_EFFECT_PENDING');
});

// Why: owner recovery must never lower either monotonic fence.
test('restore validator refuses lower seq or epoch', async t => {
  const { call, directory } = await fixture(t);
  assert.equal((await call(cancel())).ok, true);
  const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
  const module = await import('../scripts/pad-authority-restore.mjs').catch(() => ({}));
  assert.equal(typeof module.validateRestore, 'function');
  assert.throws(() => module.validateRestore({ ...snapshot, seq: 0 }, { seq: snapshot.seq, epoch: snapshot.epoch }), /RESTORE_WOULD_REWIND/);
  assert.throws(() => module.validateRestore({ ...snapshot, epoch: 0 }, { seq: snapshot.seq, epoch: snapshot.epoch }), /RESTORE_WOULD_REWIND/);
});

// Why: separate daemons must not admit concurrently against one state directory.
test('kernel lock excludes a second daemon', async t => {
  const { config } = await fixture(t);
  const { startAuthorityDaemon } = await import('../scripts/pad-authority-daemon.mjs');
  await assert.rejects(startAuthorityDaemon({ ...config, socketPath: `${config.socketPath}2` }), /AUTHORITY_ALREADY_RUNNING/);
});

// Why: a missing socket is never permission to execute locally.
test('socket unreachable maps to no admission', async t => {
  const f = await fixture(t);
  await f.stop();
  const module = await import('../scripts/workflow_runner_authority_local.mjs').catch(() => ({}));
  assert.equal(typeof module.createLocalAuthority, 'function');
  const backend = module.createLocalAuthority({ ...f.config, tenantId: 'tenant001', taskId: 'task0001' });
  const result = await backend.casAdmitEffect(claim().body);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTHORITY_UNAVAILABLE');
});
