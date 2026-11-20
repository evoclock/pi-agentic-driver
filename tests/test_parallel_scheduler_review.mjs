import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readFileSync } from 'node:fs';
let ParallelScheduler, createTreehousePorts;
async function load() {
  assert.ok(existsSync('lib/parallel-scheduler.mjs'), 'scheduler implementation exists');
  assert.ok(existsSync('lib/parallel-scheduler-treehouse.mjs'), 'Treehouse adapter exists');
  ({ ParallelScheduler } = await import('../lib/parallel-scheduler.mjs'));
  ({ createTreehousePorts } = await import('../lib/parallel-scheduler-treehouse.mjs'));
}

// Why: the ordinary fake-only gate must reject a disconnected required-TLC preflight seam.
test('M1 preflight always invokes the dedicated required liveness suite', () => {
  assert.ok(readFileSync('scripts/review_preflight.mjs', 'utf8').includes("run('node',['--test','tests/parallel_scheduler_liveness.mjs'],env);"));
});

const task = (id, touches = [id], dependsOn = [], resources = []) => ({ id, touches, dependsOn, resources });
function core(overrides = {}) {
  const leases = new Set(), dispatched = [], events = [], releases = [];
  let next = 0;
  const ports = {
    cap: 2,
    acquire: async () => { const id = String(++next); leases.add(id); return { id, path: `/fake/${id}` }; },
    dispatch: async t => { dispatched.push(t.id); },
    report: event => events.push(event), merged: async () => true, closed: async () => true,
    release: async (lease, t, outcome) => { releases.push(outcome); leases.delete(lease.id); },
    ...overrides,
  };
  return { ports, leases, dispatched, events, releases };
}
function host() {
  const calls = [], state = { allocated: false, race: null, base: 'main', merged: true,
    closed: true, dirty: false, busy: false, head: 'a'.repeat(40), foreign: [] };
  const own = { path: '/fake/task', branch: 'stream-a', lease_id: 'lease-a', lease_holder: 'scheduler', status: 'leased', processes: [] };
  const foreign = { ...own, path: '/fake/foreign', branch: 'foreign', lease_id: 'foreign', lease_holder: 'other' };
  const run = async (file, args, cwd) => {
    calls.push({ file, args, cwd });
    if (file === 'treehouse') {
      switch (args[0]) {
        case '--version': return 'treehouse v3.1.3';
        case 'status': return JSON.stringify([...state.foreign, ...(state.allocated ? [{ ...own, processes: state.busy ? [{ pid: 1 }] : [] }] : [])]);
        case 'get':
          if (state.race === 'full') { state.foreign = [foreign]; throw new Error('pool filled'); }
          if (state.race === 'error') throw new Error('allocator unavailable');
          state.allocated = true;
          if (state.race === 'uncertain') throw new Error('acquisition uncertain');
          return own.path;
        case 'return': state.allocated = false; return '';
      }
    }
    if (file === 'git') {
      if (args.includes('--show-toplevel')) return cwd;
      if (args.includes('--git-common-dir')) return '/fake/repo/.git';
      if (args[0] === 'branch') return own.branch;
      if (args.includes('HEAD')) return 'a'.repeat(40);
      if (args[0] === 'status') return state.dirty ? ' M dirty' : '';
      if (args[0] === 'remote') return 'https://github.com/evoclock/example.git';
    }
    if (file === 'gh') return JSON.stringify([{
      headRefName: own.branch, headRefOid: state.head, owner: 'evoclock', base: state.base,
      state: state.closed ? 'closed' : 'open', closedAt: state.closed ? '2026-01-01T00:00:00Z' : null,
      mergedAt: state.merged ? '2026-01-01T00:00:00Z' : null,
    }]);
    throw new Error(`unexpected command: ${file} ${args}`);
  };
  const ports = (cap = 1) => createTreehousePorts({ root: '/fake/repo', cap, base: 'main',
    branchPrefix: 'stream-', holder: 'scheduler', run, dispatch: async () => {}, report: () => {} });
  return { calls, state, foreign, ports };
}

// Why: a merge into a different branch must not release dependencies cut from the configured base.
test('S1 binds merge observation and recycling to the configured PR base', async () => {
  await load();
  const f = host(), p = f.ports(), t = task('a');
  const lease = await p.acquire(t), running = { ...t, lease };
  f.state.base = 'other';
  assert.equal(await p.merged(running), false);
  await assert.rejects(p.release(lease, running), /merge/);
  assert.ok(!f.calls.some(c => c.args[0] === 'return'));
  f.state.base = 'main'; assert.equal(await p.merged(running), true);
  assert.ok(f.calls.find(c => c.file === 'gh').args.some(a => a.includes('base:.base.ref')));
});

// Why: explicit abandonment releases conflicts and capacity but never satisfies dependent work.
test('I2 Close/Abandon conformance returns the lease and permanently blocks dependents', async () => {
  await load();
  let closed = false, refuse = false;
  const f = core({ cap: 1, closed: async () => closed });
  const release = f.ports.release;
  f.ports.release = async (...args) => { if (refuse) throw new Error('return refused'); return release(...args); };
  const s = new ParallelScheduler([task('1', ['x']), task('2', ['x']), task('3', ['y'], ['1'])], f.ports);
  assert.equal(typeof s.abandon, 'function');
  await s.tick(); await assert.rejects(s.abandon('1'), /closed/);
  closed = true; refuse = true; await assert.rejects(s.abandon('1'), /return refused/);
  assert.equal(s.snapshot()[0].state, 'running'); assert.equal(f.leases.size, 1);
  refuse = false; await s.abandon('1');
  assert.equal(s.snapshot()[0].state, 'abandoned'); assert.equal(s.snapshot()[0].lease, null);
  assert.equal(f.leases.size, 0); assert.deepEqual(f.releases, ['abandoned']);
  await s.tick(); assert.deepEqual(f.dispatched, ['1', '2']);
  await s.merge('2'); await s.tick();
  assert.deepEqual(s.snapshot().map(t => t.state), ['abandoned', 'merged', 'queued']);
  assert.equal(f.leases.size, 0); await assert.rejects(s.abandon('1'), /running/);
});

// Why: closed-unmerged recycling needs the same exact PR identity and quiet worktree as merge recycling.
test('I2 host abandonment accepts only the exact closed unmerged PR and safe return', async () => {
  await load();
  for (const fault of ['base', 'head', 'open', 'merged', 'dirty', 'busy', 'none']) {
    const f = host(), p = f.ports(), t = task('a'); const lease = await p.acquire(t), running = { ...t, lease };
    assert.equal(typeof p.closed, 'function'); f.state.merged = false;
    if (fault === 'base') f.state.base = 'other';
    if (fault === 'head') f.state.head = 'b'.repeat(40);
    if (fault === 'open') f.state.closed = false;
    if (fault === 'merged') f.state.merged = true;
    if (fault === 'dirty') f.state.dirty = true;
    if (fault === 'busy') f.state.busy = true;
    const isClosed = !['base', 'head', 'open', 'merged'].includes(fault);
    assert.equal(await p.closed(running), isClosed);
    if (fault !== 'none') {
      await assert.rejects(p.release(lease, running, 'abandoned'));
      assert.ok(!f.calls.some(c => c.args[0] === 'return'));
    } else {
      await p.release(lease, running, 'abandoned');
      assert.deepEqual(f.calls.find(c => c.args[0] === 'return').args,
        ['return', '/fake/task', '--if-lease-id', 'lease-a', '--if-lease-holder', 'scheduler']);
    }
  }
});

// Why: every started delivery must settle even when later acquisition or reporting fails.
test('S2/T1 tick aggregates loop and delivery failures and names unrecorded leases', async () => {
  await load();
  for (const fault of ['duplicate', 'acquire', 'report']) {
    let acquired = 0, settled = false;
    const delivery = new Error('delivery failed'), acquireError = new Error('acquire failed'), reportError = new Error('report failed');
    const f = core({
      acquire: async () => {
        if (++acquired === 1) return { id: 'first', path: '/fake/first' };
        if (fault === 'acquire') throw acquireError;
        return { id: 'unrecorded-b', path: '/fake/first' };
      },
      dispatch: async () => { await delay(10); settled = true; throw delivery; },
    });
    if (fault === 'report') f.ports.report = () => { throw reportError; };
    const s = new ParallelScheduler([task('a'), task('b')], f.ports);
    await assert.rejects(s.tick(), error => {
      assert.ok(error instanceof AggregateError); assert.equal(settled, true);
      assert.ok(error.errors.includes(delivery));
      if (fault === 'acquire') assert.ok(error.errors.includes(acquireError));
      else assert.ok(error.errors.some(e => e.message.includes('unrecorded-b')));
      if (fault === 'report') assert.ok(error.errors.includes(reportError));
      return true;
    });
    assert.equal(s.snapshot()[0].state, 'running'); assert.equal(s.snapshot()[0].lease.id, 'first');
    assert.equal(s.snapshot()[1].state, 'queued');
    if (fault === 'duplicate') assert.equal(f.events.at(-1).leaseId, 'unrecorded-b');
  }
});

// Why: a failed delivery alone is still uncertain and must not discard its reservation.
test('T1 delivery-only AggregateError retains every acquired reservation', async () => {
  await load();
  const delivery = new Error('delivery failed'), f = core({ dispatch: async () => { throw delivery; } });
  const s = new ParallelScheduler([task('a')], f.ports);
  await assert.rejects(s.tick(), e => { assert.ok(e instanceof AggregateError); assert.deepEqual(e.errors, [delivery]); return true; });
  assert.equal(s.snapshot()[0].state, 'running'); assert.equal(f.leases.size, 1);
});

// Why: differently cased names must not claim the same exclusive resource concurrently.
test('M3 canonical resource names serialize VM and vm across tasks', async () => {
  await load();
  const f = core(), s = new ParallelScheduler([task('a', ['a'], [], ['VM']), task('b', ['b'], [], ['vm'])], f.ports);
  await s.tick(); assert.deepEqual(f.dispatched, ['a']);
  assert.deepEqual(s.snapshot()[0].resources, ['vm']);
  await s.merge('a'); await s.tick(); assert.deepEqual(f.dispatched, ['a', 'b']);
});

// Why: native allocation races must distinguish a full pool from an uncertain successful acquisition.
test('T1 acquire race waits only without an observed task lease and never replays', async () => {
  await load();
  for (const race of ['full', 'uncertain', 'error']) {
    const f = host(), p = f.ports(); f.state.race = race;
    if (race === 'full') assert.equal(await p.acquire(task('a')), null);
    else await assert.rejects(p.acquire(task('a')), /uncertain|unavailable/);
    assert.equal(f.calls.filter(c => c.args[0] === 'get').length, 1);
    assert.ok(!f.calls.some(c => c.args[0] === 'return'));
  }
});

// Why: foreign controllers' occupants count against the pool ceiling without being recycled by this scheduler.
test('T1 foreign occupants consume capacity even before this scheduler acquires a lease', async () => {
  await load();
  const f = host(); f.state.foreign = [f.foreign];
  assert.equal(await f.ports(1).acquire(task('a')), null);
  const p = f.ports(2); assert.equal((await p.acquire(task('a'))).id, 'lease-a');
  assert.equal(await p.acquire(task('b')), null);
  assert.equal(f.calls.filter(c => c.args[0] === 'get').length, 1);
  assert.ok(!f.calls.some(c => c.args[0] === 'return'));
});
