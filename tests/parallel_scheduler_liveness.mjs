import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runTlc } from './helpers/tlc.mjs';

const source = 'docs/design/verify';
const env = { ...process.env, TLC_REQUIRED: '1' };

// Why: the checked liveness property must run in normal preflight rather than remain an unexecuted probe.
test('scheduler fair liveness is required by preflight and passes TLC', () => {
  assert.ok(existsSync(`${source}/ParallelScheduler-liveness.cfg`), 'scheduler liveness configuration exists');
  const preflight = readFileSync('scripts/review_preflight.mjs', 'utf8');
  assert.ok(preflight.includes("run('node',['--test','tests/parallel_scheduler_liveness.mjs'],env);"), 'preflight invokes the required liveness suite');
  const run = runTlc({ source, model: 'ParallelScheduler.tla', config: 'ParallelScheduler-liveness.cfg', env });
  assert.equal(run.skipped, false);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Model checking completed\. No error has been found/);
  assert.match(run.stdout, /Finished checking temporal properties/);
});

// Why: a disabled Start action must falsify the sole named liveness property without changing its matcher or accepting parser errors.
test('scheduler starvation control produces its required temporal counterexample', () => {
  assert.ok(existsSync(`${source}/ParallelScheduler-unsafe-starve.cfg`), 'scheduler starvation configuration exists');
  const config = readFileSync(`${source}/ParallelScheduler-unsafe-starve.cfg`, 'utf8');
  assert.deepEqual([...config.matchAll(/^\s*PROPERTY\s+(\w+)\s*$/gm)].map(m => m[1]), ['NoStarvation']);
  const run = runTlc({ source, model: 'ParallelScheduler.tla', config: 'ParallelScheduler-unsafe-starve.cfg', env });
  assert.equal(run.skipped, false);
  assert.equal(run.status, 13, run.stdout + run.stderr);
  assert.match(run.stdout, /Temporal properties were violated/);
  assert.match(run.stdout, /counter-example/);
});
