import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const runnerUrl = new URL('../lib/model-fidelity/tlc-runner.mjs', import.meta.url);
const runnerModule = existsSync(runnerUrl) ? await import(runnerUrl.href) : null;
const { runTlcChecks, ADAPTER } = runnerModule ?? {};

mkdirSync(join(process.cwd(), '.scratch'), { recursive: true });
const dir = mkdtempSync(join(process.cwd(), '.scratch/mf-t06b-runner-'));
const spec = join(dir, 'Sample.tla');
const config = join(dir, 'Sample.cfg');
writeFileSync(spec, '---- MODULE Sample ----\n====\n');
writeFileSync(config, 'SPECIFICATION Spec\n');
const checks = [0, 1].map(n => ({ name: `case${n}`, spec, config, out: join(dir, `run${n}`), properties: ['Safety'] }));
const run = (spawn, options = {}) => {
  assert.ok(runnerModule, 'TLC runner must be available');
  return runTlcChecks({ checks: checks.slice(0, 1), spawn, ...options });
};

// Why: exit zero without a checker summary cannot prove any named property.
test('raw result keeps nonzero, counterexample and zero-without-summary distinct for the classifier', async () => {
  for (const [status, stdout] of [[1, 'configuration error'], [1, 'Error: Invariant Safety is violated.\nError: The behavior up to this point is:'], [0, 'started only']]) {
    const result = await run(() => ({ status, stdout, stderr: '' }));
    assert.equal(result.raw[0].exitCode, status);
    assert.equal(result.raw[0].output.includes(stdout), true);
    assert.deepEqual(result.raw[0].unchecked, ['Safety']);
    assert.equal(result.raw[0].completion, 'unknown');
    assert.equal(result.raw[0].inputs.spec.sha256.length, 64);
  }
});

// Why: a buffer limit and a clock limit must not become a model result.
test('timeout and truncated output remain separate raw errors', async () => {
  for (const code of ['ETIMEDOUT', 'ENOBUFS']) {
    const result = await run(() => ({ status: null, stdout: 'partial', stderr: '', error: { code } }));
    assert.equal(result.raw[0].timedOut, code === 'ETIMEDOUT');
    assert.equal(result.raw[0].outputTruncated, code === 'ENOBUFS');
    assert.deepEqual(result.raw[0].unchecked, ['Safety']);
  }
});

// Why: missing dependencies cannot be mistaken for a completed check.
test('unavailable checker and missing Java retain the port reason', async () => {
  for (const reason of ['No tlc on PATH', 'requires an already installed Java']) {
    const result = await run(() => ({ status: 3, stdout: JSON.stringify({ status: 'blocked', reason }), stderr: '' }));
    assert.equal(result.raw[0].adapterResult.reason, reason);
    assert.deepEqual(result.raw[0].unchecked, ['Safety']);
  }
});

// Why: later interpretation must not erase observations or silently certify a property.
test('classifier injection does not modify the raw completion record', async () => {
  const result = await run(() => ({ status: 0, stdout: 'summary', stderr: '' }), { classify: raw => ({ property: raw.properties[0], status: 'unknown' }) });
  assert.equal(result.raw[0].classification.status, 'unknown');
  assert.equal(result.raw[0].completion, 'unknown');
});

// Why: control work must stop at its own budget while preserving unchecked names.
test('total budget stops later controls without stopping delivery', async () => {
  assert.ok(runnerModule, 'TLC runner must be available');
  let tick = 0;
  const result = await runTlcChecks({ checks, now: () => tick, budget: { totalMs: 10 }, spawn: () => { tick = 11; return { status: 0, stdout: 'done', stderr: '' }; } });
  assert.equal(result.status, 'budget-exhausted');
  assert.deepEqual(result.unchecked, ['case1']);
  assert.equal(result.raw.length, 1);
});

// Why: neither a silent state-limit omission nor a caller-chosen executable is safe.
test('unsupported state budget and arbitrary adapter are refused rather than silently ignored', async () => {
  const result = await run(() => { throw Error('must not spawn'); }, { budget: { stateLimit: 10 } });
  assert.equal(result.status, 'unsupported-state-limit');
  await assert.rejects(run(() => {}, { adapter: '/bin/sh' }), /installed TLC adapter/);
});

// Why: stubbed exits do not establish whether the installed checker really finishes or finds a counterexample.
test('installed TLC runs safe and unsafe fixtures through the adapter', async t => {
  assert.ok(runnerModule, 'TLC runner must be available');
  if (spawnSync(process.execPath, [ADAPTER, '--check'], { encoding: 'utf8' }).status !== 0) return t.skip('TLC not installed');
  const scratch = mkdtempSync(join(process.cwd(), '.scratch/mf-t06b-real-'));
  const fixture = resolve('tests/fixtures/model-fidelity-runner');
  for (const name of ['Sample.tla', 'Safe.cfg', 'Unsafe.cfg']) copyFileSync(join(fixture, name), join(scratch, name));
  const realChecks = ['Safe', 'Unsafe'].map(name => ({ name, spec: join(scratch, 'Sample.tla'), config: join(scratch, `${name}.cfg`), out: join(scratch, `${name}-run`), properties: [name] }));
  const result = await runTlcChecks({ checks: realChecks, budget: { totalMs: 60000, checkMs: 30000 } });
  assert.equal(result.status, 'finished');
  assert.equal(result.raw[0].adapterResult.status, 'checked-no-errors');
  assert.equal(result.raw[1].adapterResult.status, 'failed');
  assert.match(result.raw[1].checkerOutput, /Invariant Unsafe is violated/);
  assert.equal(result.raw[0].checker.sha256.length, 64);
});
