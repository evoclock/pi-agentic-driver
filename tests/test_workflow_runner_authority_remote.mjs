import test from 'node:test';
import assert from 'node:assert/strict';
const remote = await import('../scripts/workflow_runner_authority_remote.mjs').catch(() => ({}));
const ids = { tenantId: 'tenant_0001', taskId: 'task_000001' };
function backend(fetch, options = {}) {
  assert.equal(typeof remote.createRemoteAuthority, 'function', 'remote backend exists');
  return remote.createRemoteAuthority({ ...ids, baseUrl: 'https://authority.invalid', fetch, ...options });
}
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const request = { ...ids, requestId: '00000000-0000-4000-8000-000000000001', reasonCode: 'owner_cancel', clientSeenSeq: 0 };
// Why: transport headers and routing must preserve the shared request identity exactly.
test('routes and Idempotency-Key match body requestId', async () => {
  const calls = []; const b = backend(async (url, init) => { calls.push({ url, init }); return response(200, { ok: true, seq: 1, epoch: 1 }); });
  await b.commitCancel(request); await b.readEpoch(); await b.casAdmitEffect({ ...request, op: 'claim' }); await b.status();
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), [
    '/v1/tenants/tenant_0001/tasks/task_000001/cancel', '/v1/tenants/tenant_0001/tasks/task_000001/epoch',
    '/v1/tenants/tenant_0001/tasks/task_000001/admit', '/v1/status']);
  assert.equal(calls[0].init.headers['Idempotency-Key'], JSON.parse(calls[0].init.body).requestId);
  assert.equal(calls[1].init.method, 'GET');
});
// Why: disabled and unavailable services have identical no-admission semantics.
for (const status of [404, 503]) {
  test(`HTTP ${status} refuses admission after three same-body retries`, async () => {
    const bodies = []; const b = backend(async (_url, init) => { bodies.push(init.body); return response(status, null); });
    const result = await b.casAdmitEffect({ ...request, op: 'effect' });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'AUTHORITY_UNAVAILABLE');
    assert.equal(bodies.length, 4); assert.equal(new Set(bodies).size, 1);
  });
}
// Why: a timeout must abort the call and never turn into an admission.
test('timeout aborts and refuses admission', async () => {
  let calls = 0; const b = backend((_url, init) => new Promise((_resolve, reject) => {
    calls++; init.signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true });
  }), { timeoutMs: 2 });
  const result = await b.casAdmitEffect({ ...request, op: 'effect' });
  assert.equal(result.error.code, 'AUTHORITY_UNAVAILABLE'); assert.equal(calls, 4);
});
// Why: a lost success reply must replay with the original idempotency key and body.
test('lost reply retries the same immutable body', async () => {
  const bodies = []; const b = backend(async (_url, init) => {
    bodies.push(init.body); if (bodies.length === 1) throw new Error('synthetic lost reply');
    return response(200, { ok: true, seq: 1, epoch: 1, replayed: true });
  });
  assert.equal((await b.commitCancel(request)).replayed, true); assert.deepEqual(bodies[0], bodies[1]);
});
// Why: tenant credentials cannot be repaired by blind retries or task identity changes.
test('403 TENANT_MISMATCH is terminal and never retried', async () => {
  let calls = 0; const b = backend(async () => { calls++; return response(403, { ok: false, error: { code: 'TENANT_MISMATCH', retryable: false } }); });
  assert.equal((await b.commitCancel(request)).error.code, 'TENANT_MISMATCH'); assert.equal(calls, 1);
});
// Why: CAS requires a new observation and idempotency mismatches require reconciliation.
for (const code of ['CAS_CONFLICT', 'IDEMPOTENCY_MISMATCH']) {
  test(`${code} is not blindly retried`, async () => {
    let calls = 0; const b = backend(async () => { calls++; return response(409, { ok: false, error: { code, retryable: false } }); });
    assert.equal((await b.casAdmitEffect({ ...request, op: 'claim' })).error.code, code); assert.equal(calls, 1);
  });
}
// Why: authentication is supplied by the caller and fixtures never contain real tokens.
test('pluggable authHeaders is called with placeholder credentials only', async () => {
  let authCalls = 0; let headers;
  const b = backend(async (_url, init) => { headers = init.headers; return response(200, { ok: true, seq: 0, epoch: 0 }); }, {
    authHeaders: async () => { authCalls++; return { 'CF-Access-Client-Id': '<CF_ACCESS_CLIENT_ID>', 'CF-Access-Client-Secret': '<CF_ACCESS_CLIENT_SECRET>' }; }
  });
  await b.readEpoch(); assert.equal(authCalls, 1); assert.equal(headers['CF-Access-Client-Secret'], '<CF_ACCESS_CLIENT_SECRET>');
});
// Why: malformed success responses cannot be treated as positive effect admission.
test('invalid JSON success is unavailable, never admitted', async () => {
  const b = backend(async () => response(200, null));
  assert.equal((await b.casAdmitEffect({ ...request, op: 'effect' })).ok, false);
});
