import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, open, readFile, writeFile, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { createAttempt, publishOutput } from '../lib/model-fidelity/attempts.mjs';
import { reserveRequest, publishRequest, readRequest, readArtifact } from '../lib/model-fidelity/requests.mjs';

async function fixture() {
  await mkdir('.scratch', { recursive: true });
  const storeRoot = await mkdtemp(path.resolve('.scratch/mf-requests-'));
  const claim = await createAttempt({ storeRoot, unitId: 'unit', attemptId: 'first', owner: 'worker' });
  const request = { schema: 'model-fidelity.request.v1', requestId: 'r1', unitId: 'unit', attemptId: 'first', operation: 'prepare', payload: { mode: 'light', planRef: 'plan', designRefs: [] } };
  return { storeRoot, claim, request, checkerVersion: 'tlc-2', inputDigest: 'a'.repeat(64) };
}

// Why: concurrent callers must allocate one request key without repeating an uncertain effect.
test('one reservation wins and the identical caller sees pending rather than rerunning', async () => {
  const f = await fixture();
  const attempts = await Promise.all([reserveRequest(f), reserveRequest(f)]);
  assert.deepEqual(attempts.map(x => x.status).sort(), ['pending', 'reserved']);
  assert.equal((await readRequest(f)).status, 'pending');
  assert.equal(await readFile(path.join(f.storeRoot, 'units/unit/requests/r1.json'), 'utf8') !== '', true);
});

// Why: a duplicate arriving while the winner writes must never mistake an in-flight reservation for a crash.
test('concurrent identical reservations never observe a transient interrupted file', async () => {
  const f = await fixture();
  const probe = await open(path.join(f.storeRoot, 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.writeFile;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const writing = new Promise(resolve => { entered = resolve; });
  let first = true;
  prototype.writeFile = async function (...args) {
    if (first) { first = false; entered(); await held; }
    return original.apply(this, args);
  };
  try {
    const winner = reserveRequest(f);
    await writing;
    const duplicate = await reserveRequest(f);
    release();
    const statuses = [duplicate.status, (await winner).status].sort();
    assert.deepEqual(statuses, ['pending', 'reserved']);
  } finally { release(); prototype.writeFile = original; }
});

// Why: a mismatched duplicate must reject only through its caller, even while temp-file cleanup is pending.
test('conflicting reservation rejection stays handled during delayed cleanup', async () => {
  const f = await fixture();
  assert.equal((await reserveRequest(f)).status, 'reserved');
  const unlink = fs.promises.unlink;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const cleaning = new Promise(resolve => { entered = resolve; });
  const unhandled = [];
  const onUnhandled = error => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  fs.promises.unlink = async file => { entered(); await held; return unlink(file); };
  syncBuiltinESMExports();
  try {
    const duplicate = reserveRequest({ ...f, checkerVersion: 'tlc-3' });
    await cleaning;
    await new Promise(resolve => setTimeout(resolve, 100)); // Hold cleanup so inspect can reject first.
    release();
    await assert.rejects(duplicate, { code: 'request-conflict' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    release();
    fs.promises.unlink = unlink;
    syncBuiltinESMExports();
    process.off('unhandledRejection', onUnhandled);
  }
});

// Why: an actually empty reservation left behind remains interrupted rather than pending.
test('an existing empty reservation remains interrupted', async () => {
  const f = await fixture();
  await mkdir(path.join(f.storeRoot, 'units/unit/requests'));
  await writeFile(path.join(f.storeRoot, 'units/unit/requests/r1.json'), '');
  assert.equal((await reserveRequest(f)).status, 'interrupted');
});

// Why: the request key must bind payload bytes, checker version, input bytes and attempt identity.
test('a wrong key cannot reuse results or overwrite the reservation', async () => {
  const f = await fixture();
  assert.equal((await reserveRequest(f)).status, 'reserved');
  const before = await readFile(path.join(f.storeRoot, 'units/unit/requests/r1.json'));
  for (const changed of [
    { inputDigest: 'b'.repeat(64) }, { checkerVersion: 'tlc-3' },
    { request: { ...f.request, payload: { ...f.request.payload, planRef: 'other' } } },
    { request: { ...f.request, attemptId: 'second' } },
  ]) await assert.rejects(reserveRequest({ ...f, ...changed }), { code: 'request-conflict' });
  assert.deepEqual(await readFile(path.join(f.storeRoot, 'units/unit/requests/r1.json')), before);
});

// Why: an interrupted publication must remain visible and cannot be treated as a completed result.
test('a result becomes reusable only after publication, with exact bytes preserved', async () => {
  const f = await fixture();
  await reserveRequest(f);
  assert.equal((await readRequest(f)).status, 'pending');
  const bytes = Buffer.from('{"ok":true}\n');
  assert.equal((await publishRequest({ ...f, bytes })).status, 'published');
  assert.deepEqual((await reserveRequest(f)).bytes, bytes);
  assert.deepEqual((await readRequest(f)).bytes, bytes);
  await assert.rejects(publishRequest({ ...f, bytes: '{}' }), { code: 'request-conflict' });
  assert.equal(await readFile(path.join(f.storeRoot, 'units/unit/attempts/first/results/r1.json'), 'utf8'), bytes.toString());
});

// Why: an interrupted output without a reservation cannot be silently claimed as this request.
test('unclaimed existing result is a conflict, not a recovered duplicate', async () => {
  const f = await fixture();
  await publishOutput(f.claim, { kind: 'result', ids: { requestId: 'r1' }, bytes: '{}' });
  await assert.rejects(reserveRequest(f), { code: 'request-conflict' });
});

// Why: only files under the owned attempt may be read, up to the configured byte ceiling.
test('artifact reads reject traversal, symlinks, metadata, and oversized evidence', async () => {
  const f = await fixture();
  await publishOutput(f.claim, { kind: 'view', ids: { viewId: 'lifecycle', resultId: 'v1' }, name: 'diagram.svg', bytes: '12345' });
  const ref = 'views/lifecycle/v1/diagram.svg';
  assert.deepEqual((await readArtifact(f.claim, ref, { maxBytes: 5 })).bytes, Buffer.from('12345'));
  assert.deepEqual(await readArtifact(f.claim, ref, { maxBytes: 4 }), { status: 'too-large', size: 5 });
  for (const invalid of ['../owner.json', '/etc/passwd', 'owner.json', 'results/../../owner.json', 'views//x', 'input/bundles/../../owner.json']) {
    await assert.rejects(readArtifact(f.claim, invalid), TypeError);
  }
  const dir = path.join(f.storeRoot, 'units/unit/attempts/first/views/lifecycle/v1');
  await symlink('diagram.svg', path.join(dir, 'linked.svg'));
  await assert.rejects(readArtifact(f.claim, 'views/lifecycle/v1/linked.svg'), TypeError);
  await mkdir(path.join(dir, 'alias'));
  await writeFile(path.join(dir, 'alias', 'inside'), 'ok');
  assert.deepEqual((await readArtifact(f.claim, 'views/lifecycle/v1/alias/inside')).bytes, Buffer.from('ok'));
  await symlink('alias', path.join(dir, 'symlink-dir'));
  await assert.rejects(readArtifact(f.claim, 'views/lifecycle/v1/symlink-dir/inside'), TypeError);
});
