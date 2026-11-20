import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

async function api() {
  assert.ok(existsSync('lib/parallel-scheduler.mjs'), 'scheduler implementation exists');
  return import('../lib/parallel-scheduler.mjs');
}
function task(id, touches, dependsOn = [], resources = []) {
  return { id, touches, dependsOn, resources };
}
function fake(cap = 2) {
  const leases = new Map(), dispatched = [], events = [];
  let sequence = 0;
  return { leases, dispatched, events,
    ports: {
      acquire: async t => {
        if (leases.size === cap) return null;
        const lease = { id: String(++sequence), path: `/fake/${sequence}` };
        leases.set(lease.id, lease); return lease;
      },
      release: async lease => { assert.ok(leases.delete(lease.id)); },
      dispatch: async (t, lease) => { dispatched.push([t.id, lease.id]); },
      merged: async () => true,
      report: event => events.push(event),
    },
  };
}

// Why: the model's independent, conflict, dependency and merge transitions must agree with real scheduling.
test('model trace drains independent work and returns leases before dependent start', async () => {
  const { ParallelScheduler } = await api();
  const f = fake();
  const s = new ParallelScheduler([
    task('1', ['a/**']), task('2', ['a/file']), task('3', ['b/**'], ['1']),
    task('4', ['c/**']),
  ], { cap: 2, ...f.ports });
  await s.tick();
  assert.deepEqual(f.dispatched.map(x => x[0]), ['1', '4']);
  await s.merge('1');
  await s.tick();
  assert.deepEqual(f.dispatched.map(x => x[0]), ['1', '4', '2']);
  await s.merge('4'); await s.tick();
  assert.deepEqual(f.dispatched.map(x => x[0]), ['1', '4', '2', '3']);
  await s.merge('2'); await s.merge('3');
  assert.equal(f.leases.size, 0);
  assert.deepEqual(s.snapshot().map(x => x.state), ['merged', 'merged', 'merged', 'merged']);
});

// Why: missing or ambiguous declarations must not silently turn into independent tasks.
test('manifest lint rejects absent touches, cycles and traversal', async () => {
  const { validateManifest } = await api();
  for (const tasks of [
    [{ id: 'a', dependsOn: [], resources: [] }],
    [task('a', [])], [task('a', ['../x'])],
    [task('a', ['x'], ['missing'])],
    [task('a', ['x'], ['b']), task('b', ['y'], ['a'])],
    [task('a', ['x']), task('a', ['y'])],
  ]) assert.throws(() => validateManifest(tasks));
  assert.doesNotThrow(() => validateManifest([task('a', ['src/**'])]));
});

// Why: glob overlap must be conservative, including nested and wildcard prefixes; resources also serialize.
test('touch overlap and exclusive resources prevent concurrent starts', async () => {
  const { ParallelScheduler, touchesOverlap } = await api();
  for (const pair of [['src/**', 'src/x.js'], ['**/*.js', 'lib/a.js'], ['a/*.js', 'a/b*']])
    assert.equal(touchesOverlap(...pair), true);
  assert.equal(touchesOverlap('a/**', 'b/**'), false);
  const f = fake();
  const s = new ParallelScheduler([task('a', ['a'], [], ['vm']), task('b', ['b'], [], ['vm'])], { cap: 2, ...f.ports });
  await Promise.all([s.tick(), s.tick()]);
  assert.equal(f.dispatched.length, 1);
  await s.merge('a'); await s.tick();
  assert.equal(f.dispatched.length, 2);
});

// Why: pool exhaustion is a visible wait, and recycling errors must retain conflicts rather than leak capacity.
test('capacity wait, failed return and unconfirmed merge stay held', async () => {
  const { ParallelScheduler } = await api();
  const f = fake(0);
  const s = new ParallelScheduler([task('a', ['a'])], { cap: 1, ...f.ports });
  await s.tick(); assert.equal(s.snapshot()[0].state, 'queued');
  assert.equal(f.events.at(-1).status, 'waiting-for-slot');
  const g = fake();
  const held = new ParallelScheduler([task('a', ['a']), task('b', ['a'])], {
    cap: 1, ...g.ports, release: async () => { throw new Error('busy'); },
  });
  await held.tick(); await assert.rejects(held.merge('a'), /busy/);
  await held.tick(); assert.equal(g.dispatched.length, 1);
  assert.equal(held.snapshot()[0].state, 'running');
  const denied = new ParallelScheduler([task('a', ['a'])], { cap: 1, ...g.ports, merged: async () => false });
  await denied.tick(); await assert.rejects(denied.merge('a'), /merge/);
});

// Why: the named G8 seam must fail closed until wired and reject undeclared diff paths when wired.
test('G8 declared-touch seam is required and enforces changed paths', async () => {
  const { checkDeclaredTouches, requireG8TouchGate } = await api();
  assert.throws(() => requireG8TouchGate({}), /G8/);
  const gate = requireG8TouchGate({ checkDeclaredTouches });
  assert.equal(gate(task('a', ['src/**']), ['src/a.js']).ok, true);
  assert.equal(gate(task('a', ['src/**']), ['tests/a.js']).ok, false);
  assert.equal(gate(task('a', ['src/**']), ['../src/a.js']).ok, false);
});

// Why: every reachable merge ordering must preserve the bounded model invariants.
test('bounded model transition conformance across every merge ordering', async () => {
  const { ParallelScheduler, touchesOverlap } = await api();
  const manifest = [task('1', ['a/**']), task('2', ['a/x']), task('3', ['b/**'], ['1'])];
  let traces = 0;
  async function explore(history) {
    const f = fake(); const s = new ParallelScheduler(manifest, { cap: 2, ...f.ports });
    const merged = new Set();
    for (const id of history) { await s.tick(); await s.merge(id); merged.add(id); }
    await s.tick();
    const snap = s.snapshot(), running = snap.filter(t => t.state === 'running');
    assert.ok(running.length <= 2);
    assert.equal(new Set(running.map(t => t.lease.id)).size, running.length);
    for (const t of running) {
      assert.ok(t.dependsOn.every(id => merged.has(id)));
      for (const u of running) if (u.id !== t.id)
        assert.ok(!t.touches.some(x => u.touches.some(y => touchesOverlap(x, y))));
    }
    for (const t of snap.filter(t => t.state === 'merged')) assert.equal(t.lease, null);
    if (!running.length) { assert.equal(merged.size, 3); assert.equal(f.leases.size, 0); traces++; }
    for (const t of running) await explore([...history, t.id]);
  }
  await explore([]); assert.equal(traces, 2);
});

async function hostApi() {
  assert.ok(existsSync('lib/parallel-scheduler-treehouse.mjs'), 'Treehouse host adapter exists');
  return import('../lib/parallel-scheduler-treehouse.mjs');
}
function fakeHost() {
  const calls = []; let allocated = false;
  const slot = { path: '/fake/task', status: 'leased', branch: 'stream-a', lease_id: 'lease-a', lease_holder: 'scheduler', processes: [] };
  const state = { full: false, merged: true, dirty: false, changed: false };
  const run = async (file, args, cwd) => {
    calls.push({ file, args, cwd });
    if (file === 'treehouse') {
      if (args[0] === '--version') return 'treehouse v3.1.3';
      if (args[0] === 'status') return JSON.stringify(state.full ? [slot] : allocated ? [{...slot, lease_id: state.changed ? 'other' : slot.lease_id}] : []);
      if (args[0] === 'get') { allocated = true; return slot.path; }
      if (args[0] === 'return') { allocated = false; return ''; }
    }
    if (file === 'git') {
      if (args.includes('--git-common-dir')) return '/fake/repo/.git';
      if (args.includes('--show-toplevel')) return cwd;
      if (args[0] === 'branch') return 'stream-a';
      if (args[0] === 'status') return state.dirty ? ' M changed' : '';
      if (args.includes('HEAD')) return 'a'.repeat(40);
      if (args[0] === 'remote') return 'https://github.com/evoclock/example.git';
    }
    if (file === 'gh') return JSON.stringify(state.merged ? [{headRefName: 'stream-a', headRefOid: 'a'.repeat(40), owner: 'evoclock', base: 'main', mergedAt: '2026-01-01T00:00:00Z'}] : []);
    throw new Error(`unexpected fake command ${file} ${args}`);
  };
  return { run, calls, state };
}

// Why: real host plumbing must request a durable Treehouse lease and return only that observed identity after merge.
test('Treehouse adapter acquires a worktree and conditionally returns exact merged lease', async () => {
  const { createTreehousePorts } = await hostApi(); const f = fakeHost(); const launched = [];
  const ports = createTreehousePorts({ root: '/fake/repo', cap: 2, base: 'main', branchPrefix: 'stream-', holder: 'scheduler', run: f.run, dispatch: async (...args) => launched.push(args), report: () => {} });
  const t = task('a', ['src/**']); const lease = await ports.acquire(t);
  assert.equal(lease.path, '/fake/task'); assert.equal(lease.id, 'lease-a');
  assert.deepEqual(f.calls.find(c => c.file === 'treehouse' && c.args[0] === 'get').args, ['get', '--lease', '--base', 'main', '--branch', 'stream-a', '--lease-holder', 'scheduler']);
  await ports.dispatch(t, lease); assert.equal(launched.length, 1);
  const running = {...t, lease}; assert.equal(await ports.merged(running), true);
  await ports.release(lease, running);
  assert.deepEqual(f.calls.find(c => c.args[0] === 'return').args, ['return', '/fake/task', '--if-lease-id', 'lease-a', '--if-lease-holder', 'scheduler']);
  assert.ok(!f.calls.some(c => c.args.includes('clone') || c.args.includes('--force')));
});

// Why: global slot pressure and changed, dirty or unmerged worktrees must never authorize unsafe returns.
test('Treehouse adapter visibly waits at cap and refuses unverified recycling', async () => {
  const { createTreehousePorts } = await hostApi();
  for (const fault of ['full', 'merged', 'dirty', 'changed']) {
    const f = fakeHost(); const ports = createTreehousePorts({ root: '/fake/repo', cap: 1, base: 'main', branchPrefix: 'stream-', holder: 'scheduler', run: f.run, dispatch: async () => {}, report: () => {} });
    const t = task('a', ['src/**']);
    if (fault === 'full') { f.state.full = true; assert.equal(await ports.acquire(t), null); assert.ok(!f.calls.some(c => c.args[0] === 'get')); continue; }
    const lease = await ports.acquire(t); f.state[fault] = fault === 'merged' ? false : true;
    await assert.rejects(ports.release(lease, {...t, lease}));
    assert.ok(!f.calls.some(c => c.args[0] === 'return'));
  }
});
