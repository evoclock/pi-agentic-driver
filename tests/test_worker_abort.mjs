import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeHerdrCommunication } from '../scripts/enforcement/herdr_communication_pi.js';

const schema = 'agentic-driver.worker-abort.v1';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const profiles = new Set();
const createdProfiles = new Set();
const ownedFixtureLeaks = (exists = fs.existsSync) => [...createdProfiles].filter((profile) => exists(profile));
afterEach(() => {
  for (const profile of profiles) fs.rmSync(profile, { recursive: true, force: true });
  profiles.clear();
});
function fixture() {
  const profile = fs.mkdtempSync(join(tmpdir(), 'abort-'));
  profiles.add(profile);
  createdProfiles.add(profile);
  const sessionId = 'session-one';
  const dir = join(profile, 'agentic/worker-control', hash(sessionId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let now = 100000;
  const cap = { schema, sessionId, paneId: 'w1:p2', repository: process.cwd(), running: true,
    turnId: 'pi-turn-one', toolCallIds: ['blocking-tool'], updatedAt: now };
  const save = () => fs.writeFileSync(join(dir, 'capability.json'), JSON.stringify(cap), { mode: 0o600 });
  save();
  const agent = { name: 'worker', agent: 'pi', status: 'working', repository: process.cwd(), pane_id: 'w1:p2',
    agent_session: { agent: 'pi', kind: 'session_id', value: sessionId }, state_change_seq: 7 };
  const calls = [];
  const options = { workerControlDir: profile, now: () => now, runProcess: async ({ argv }) => {
    calls.push([...argv]);
    if (argv[0] === 'tab' && argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ tabs: [] }) };
    if (agent.name === 'missing') return { code: 1, stdout: JSON.stringify({ error: { code: 'agent_not_found' } }) };
    return { code: 0, stdout: JSON.stringify({ type: 'agent_info', agent }) };
  } };
  const request = { action: 'abort', role: 'worker', turnId: cap.turnId, reason: 'tool is stuck' };
  const run = (params = request) => executeHerdrCommunication(params, { cwd: process.cwd(), sessionManager: { getSessionId: () => 'requester' } }, options);
  const requestPath = () => join(dir, `request-${hash(cap.turnId)}.json`);
  const ackPath = () => join(dir, `ack-${hash(cap.turnId)}.json`);
  const audit = () => fs.readFileSync(join(profile, 'agentic/worker-control/audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { profile, dir, cap, agent, options, calls, request, run, save, requestPath, ackPath, audit, advance: (n) => { now += n; } };
}
async function listener(f) {
  const mod = await import('../scripts/enforcement/worker_abort_pi.js').catch(() => ({}));
  assert.equal(typeof mod.registerWorkerAbortListener, 'function', 'worker listener must be shipped');
  const handlers = new Map(); let poll; let watchCallback; let closed = 0; let aborted = 0; let pending = false;
  const controller = new AbortController();
  const ctx = { cwd: process.cwd(), lease: { id: 'unchanged-lease' }, sessionManager: { getSessionId: () => f.cap.sessionId },
    hasPendingMessages: () => pending, abort: () => { aborted++; controller.abort(); } };
  const steers = [];
  mod.registerWorkerAbortListener({ on: (name, fn) => handlers.set(name, fn), sendUserMessage: (text, options) => steers.push({ text, options }) }, {
    workerControlDir: f.profile, now: f.options.now,
    env: { HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1', HERDR_PANE_ID: 'w1:p2' },
    watch: (_path, callback) => { watchCallback = callback; return { on() {}, close() { closed++; } }; },
    setInterval: (fn) => { poll = fn; return { unref() {} }; }, clearInterval: () => { closed++; },
  });
  await handlers.get('session_start')({}, ctx);
  await handlers.get('turn_start')({ turnIndex: 0, timestamp: 100000 }, ctx);
  await handlers.get('tool_execution_start')({ toolCallId: 'blocking-tool' }, ctx);
  Object.assign(f.cap, JSON.parse(fs.readFileSync(join(f.dir, 'capability.json'))));
  f.request.turnId = f.cap.turnId;
  return { handlers, ctx, controller, steers, poll: () => poll(), watch: () => watchCallback('rename', `request-${hash(f.cap.turnId)}.json`),
    aborted: () => aborted, closed: () => closed, pending: (v) => { pending = v; } };
}

// Why: native steering must bind the exact turn, expire, audit, and consume at most once without terminal writes.
test('native steer is audited, turn bound, expiring and consumed only once', async () => {
  for (const expired of [false, true]) {
    const f = fixture(); const l = await listener(f);
    const request = { action: 'steer', role: 'worker', prompt: 'bounded steer', timeoutMs: 1000, turnId: f.cap.turnId, reason: 'change focus' };
    const result = await f.run(request);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.deliveryId);
    if (expired) f.advance(16000);
    l.poll(); l.poll();
    assert.equal(l.steers.length, expired ? 0 : 1);
    if (!expired) {
      assert.match(l.steers[0].text, /bounded steer/);
      assert.deepEqual(l.steers[0].options, { deliverAs: 'steer' });
      assert.equal((await f.run({ ...request, turnId: 'old' })).ok, false);
    }
    assert.equal(l.aborted(), 0);
    assert.ok(f.audit().some((row) => row.operation === 'steer'));
    await l.handlers.get('session_shutdown')({}, l.ctx);
  }
});

// Why: target guards, capability freshness and exact turn binding must fail closed, not fall through to terminal input.
test('abort refusals and audit cover all unsafe targets', async () => {
  const cases = [
    ['target_role_denied', (f) => { f.request.role = 'coordinator'; }],
    ['target_role_denied', (f) => { f.request.role = 'coordinator-review'; }],
    ['agent_not_found', (f) => { f.agent.name = 'missing'; f.request.role = 'missing'; }],
    ['agent_mismatch', (f) => { f.agent.agent = 'other'; }],
    ['repository_mismatch', (f) => { f.agent.repository = '/unregistered'; }],
    ['turn_identity_required', (f) => { delete f.request.turnId; }],
    ['stale_turn', (f) => { f.request.turnId = 'old-turn'; }],
    ['turn_finished', (f) => { f.agent.status = 'idle'; }],
    ['turn_finished', (f) => { f.cap.running = false; f.save(); }],
    ['abort_capability_unavailable', (f) => { fs.renameSync(join(f.dir, 'capability.json'), join(f.dir, 'old-capability.json')); }],
    ['abort_capability_unavailable', (f) => { f.cap.schema = 'unsupported'; f.save(); }],
    ['abort_capability_unavailable', (f) => { f.advance(20000); }],
    ['abort_capability_unavailable', (f) => { f.cap.sessionId = 'wrong-session'; f.save(); }],
  ];
  for (const [code, change] of cases) {
    const f = fixture(); change(f); const result = await f.run();
    assert.equal(result.code, code, JSON.stringify(result));
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(f.requestPath()), false);
    const rows = f.audit(); assert.equal(rows.at(-1).outcome, code);
    assert.equal(rows.at(-1).requestingAgent, 'requester');
  }
});

// Why: a resumed session in another pane must not cancel a listener outside the observed target; absent pane evidence also fails closed.
test('abort refuses a capability published from a different pane than Herdr observed', async () => {
  for (const paneId of ['w1:p2', undefined]) {
    const f = fixture(); f.cap.paneId = 'w1:p99'; f.agent.pane_id = paneId; f.save();
    const result = await f.run();
    assert.equal(result.code, 'abort_capability_unavailable');
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(f.requestPath()), false);
    assert.equal(f.audit().at(-1).outcome, 'abort_capability_unavailable');
    const observed = await f.run({ action: 'get', role: 'worker' });
    assert.equal(observed.observation.abortTarget, undefined);
  }
});

// Why: separate timestamp reads can widen the exact request window and make the listener refuse a fresh abort.
test('abort request window survives a clock tick between reads', async () => {
  const f = fixture(); let now = 100000; f.options.now = () => now++;
  const l = await listener(f);
  const receipt = await f.run();
  assert.equal(receipt.status, 'delivered');
  const request = JSON.parse(fs.readFileSync(f.requestPath()));
  assert.equal(request.expiresAt - request.createdAt, 15000);
  assert.equal(receipt.abortedAt, new Date(request.createdAt).toISOString());
  l.poll();
  assert.equal(JSON.parse(fs.readFileSync(f.ackPath())).status, 'abort_requested');
  assert.equal(l.aborted(), 1);
  await l.handlers.get('session_shutdown')({}, l.ctx);
});

// Why: a delivery receipt cannot claim cancellation or success without an atomically published request.
test('abort receipts are delivery-only and concurrent repeats publish once', async () => {
  const f = fixture();
  const [first, again] = await Promise.all([f.run(), f.run({ ...f.request, reason: 'repeat' })]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.status, 'delivered');
  assert.deepEqual(again, first);
  assert.equal(first.sessionId, f.cap.sessionId);
  assert.equal(first.nonAuthorizing, true); assert.equal(first.authorityCreated, false);
  assert.equal(first.allowPiQueueRestore, false);
  assert.equal(first.settled, undefined);
  assert.ok(!['aborted', 'ended'].includes(first.status));
  assert.equal(fs.existsSync(f.requestPath()), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.requestPath())).receipt, first);
  assert.equal(fs.readdirSync(f.dir).filter((p) => p.startsWith('request-')).length, 1);
  assert.equal(f.audit().filter((row) => row.phase === 'outcome').length, 2);
});

// Why: successful abort is in-process only; instrument both host effects and the fake Herdr transport.
test('abort containment permits read-only observations and owned channel writes only', async (t) => {
  const f = fixture(); const writes = []; const forbidden = [];
  for (const key of ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync']) {
    t.mock.method(childProcess.default, key, () => { forbidden.push(key); throw new Error('forbidden child process'); });
  }
  t.mock.method(process, 'kill', () => { forbidden.push('kill'); throw new Error('forbidden signal'); });
  const originalWrite = fs.default.writeFileSync;
  t.mock.method(fs.default, 'writeFileSync', (path, ...args) => { writes.push(String(path)); return originalWrite(path, ...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await f.run();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(forbidden, []);
  assert.deepEqual(f.calls.map((argv) => argv.slice(0, 2)), [['agent', 'get'], ['tab', 'list']]);
  assert.ok(f.calls.every((argv) => !argv.join(' ').match(/send[-_](keys|text|input)|command.invoke|abort/)));
  assert.ok(writes.length > 0);
  assert.ok(writes.every((p) => p.startsWith(join(f.profile, 'agentic/worker-control'))));
  assert.ok(writes.every((p) => !p.match(/settings|profile|registry|approvals/)));
});

// Why: the fake asynchronous blocking tool must cancel while preserving the worker session, lease and PAD delivery queue.
test('worker abort cancels a blocking tool and a queued follow-up reaches the same session', async () => {
  const f = fixture(); const l = await listener(f); const leaseId = 'unchanged-lease';
  const other = fixture(); const untouched = fs.readdirSync(other.dir);
  const queued = await executeHerdrCommunication({ action: 'prompt', role: 'worker', prompt: 'follow up', timeoutMs: 1000 },
    { cwd: process.cwd() }, f.options);
  assert.equal(queued.promptSent, false);
  const blocking = new Promise((resolve) => l.controller.signal.addEventListener('abort', () => resolve('CANCELLED'), { once: true }));
  const receipt = await f.run(); assert.equal(receipt.status, 'delivered');
  assert.equal(l.aborted(), 0, 'delivery is not settlement');
  l.poll(); l.watch(); l.poll();
  assert.equal(await blocking, 'CANCELLED'); assert.equal(l.aborted(), 1);
  assert.equal(JSON.parse(fs.readFileSync(f.ackPath())).status, 'abort_requested');
  await l.handlers.get('agent_end')({}, l.ctx); f.agent.status = 'idle';
  const observed = await f.run({ action: 'get', role: 'worker' });
  assert.equal(observed.observation.status, 'idle'); assert.equal(observed.observation.sessionId, f.cap.sessionId);
  assert.equal(l.ctx.lease.id, leaseId);
  f.options.runProcess = async ({ argv }) => {
    f.calls.push([...argv]);
    if (argv[0] === 'tab' && argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ tabs: [] }) };
    if (argv[1] === 'read') return { code: 0, stdout: 'history' };
    return { code: 0, stdout: JSON.stringify({ type: argv[1] === 'prompt' ? 'agent_prompted' : 'agent_info', agent: f.agent }) };
  };
  const delivery = await f.run({ action: 'delivery', deliveryId: queued.deliveryId });
  assert.equal(delivery.promptSent, true, JSON.stringify(delivery));
  assert.equal(f.agent.agent_session.value, f.cap.sessionId);
  assert.deepEqual(fs.readdirSync(other.dir), untouched);
  assert.ok(f.audit().every((row) => row.role === 'worker'));
  assert.equal(fs.existsSync(join(other.profile, 'agentic/worker-control/audit.jsonl')), false);
  await l.handlers.get('session_shutdown')({}, l.ctx); assert.equal(l.closed(), 2);
});

// Why: Pi's Escape handler restores its internal queue to the editor, so queue restoration needs explicit opt-in.
test('worker refuses pending Pi messages unless queue restore is explicit', async () => {
  for (const allow of [false, true]) {
    const f = fixture(); const l = await listener(f); l.pending(true);
    const result = await f.run({ ...f.request, allowPiQueueRestore: allow }); assert.equal(result.ok, true);
    l.poll();
    const ack = JSON.parse(fs.readFileSync(f.ackPath()));
    assert.equal(ack.status, allow ? 'abort_requested' : 'refused');
    assert.equal(ack.code, allow ? undefined : 'pi_queue_pending');
    assert.equal(l.aborted(), allow ? 1 : 0);
  }
});

// Why: turn and tool identities must both be current; delayed requests cannot cancel later work or replay after reload.
test('worker validates late requests, tool-only identity and lifecycle boundaries', async () => {
  const f = fixture(); const l = await listener(f);
  const get = await f.run({ action: 'get', role: 'worker' });
  assert.equal(get.observation.abortTarget.turnId, f.cap.turnId);
  const result = await f.run({ action: 'abort', role: 'worker', toolCallId: 'blocking-tool', reason: 'stuck' });
  assert.equal(result.ok, true);
  await l.handlers.get('tool_execution_end')({ toolCallId: 'blocking-tool' }, l.ctx);
  l.poll(); assert.equal(l.aborted(), 0);
  assert.equal(JSON.parse(fs.readFileSync(f.ackPath())).code, 'stale_turn');
  await l.handlers.get('agent_end')({}, l.ctx);
  assert.equal((await f.run()).code, 'turn_finished');
  await l.handlers.get('turn_start')({ turnIndex: 0, timestamp: 100000 }, l.ctx);
  l.watch(); assert.equal(l.aborted(), 0);
  await l.handlers.get('session_shutdown')({}, l.ctx);
  assert.equal(JSON.parse(fs.readFileSync(join(f.dir, 'capability.json'))).running, false);
});

// Why: unsafe channel paths and failed publication must never yield an ok receipt.
test('channel symlinks, unavailable writes and malformed identity are refused', async () => {
  const f = fixture();
  const path = f.requestPath(); fs.symlinkSync(join(f.profile, 'settings.json'), path);
  const result = await f.run(); assert.equal(result.ok, false);
  assert.equal(fs.existsSync(join(f.profile, 'settings.json')), false);
  const bad = await f.run({ ...f.request, turnId: '' }); assert.equal(bad.ok, false);
  const missing = fixture(); missing.agent.agent_session = null;
  assert.equal((await missing.run()).code, 'abort_capability_unavailable');
});

// Why: an unrelated pre-existing checkout abort folder must not be mistaken for a fixture created by this suite.
test('worker abort cleanup ignores unrelated checkout folders', () => {
  const unrelated = join(process.cwd(), '.local/abort-old');
  const checked = [];
  assert.deepEqual(ownedFixtureLeaks((profile) => { checked.push(profile); return profile === unrelated; }), []);
  assert.ok(checked.length > 0, 'earlier tests must have created fixtures');
  assert.equal(checked.includes(unrelated), false);
  assert.deepEqual(ownedFixtureLeaks((profile) => profile === checked[0]), [checked[0]], 'an owned leak must still fail');
});

// Why: every fixture created by this suite must be removed after its test, even in a used checkout.
test('worker abort fixtures leave no owned folders', () => {
  assert.ok(createdProfiles.size > 0);
  assert.ok([...createdProfiles].every((profile) => profile.startsWith(join(tmpdir(), 'abort-'))));
  assert.deepEqual(ownedFixtureLeaks(), []);
  assert.equal(profiles.size, 0);
});
