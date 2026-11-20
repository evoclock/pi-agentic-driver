import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const api = await import('../scripts/workflow_runner_exit.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('/scripts/workflow_runner_exit.mjs')) throw error;
  return {};
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const boundaryPaths = [
  new URL('../scripts/enforcement/linux_microvm_cutover_pi.js', import.meta.url),
  new URL('../scripts/enforcement/linux_microvm_remote_fixture.sh', import.meta.url),
  new URL('../config/microvm-target.v1.json', import.meta.url)
];

// Why: unavailable Linux execution must never pass or call the native proof as a substitute for receipt checks.
test('Linux receipt checks explicitly park unavailable and leave the native boundary untouched', async t => {
  assert.equal(typeof api.observeExitChecks, 'function', 'G8 observation API is required');
  assert.equal(typeof api.resolveCheckRunner, 'function', 'G8 runner resolver is required');
  const repo = mkdtempSync(join(tmpdir(), 'runner-test-g8-linux-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'fixture');
  writeFileSync(join(repo, 'check.mjs'), "console.log('# tests 1');\n");
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const before = boundaryPaths.map(path => digest(readFileSync(path)));
  let invoked = 0;
  const forbidden = () => { invoked++; throw Error('Native boundary must not be called'); };
  const deps = { runCheck: forbidden, microvm: forbidden, execute: forbidden, detect: () => ({ platform: 'linux', linux: { ok: true } }) };
  const selected = await api.resolveCheckRunner({ checks: { runner: 'linux' } }, deps);
  assert.equal(selected.park, 'checks-runner-unavailable');
  assert.notEqual(selected.runner, 'host');
  const observed = await api.observeExitChecks({
    repo, commit, runner: 'linux',
    binding: { taskId: 'task', stepId: 'build', epoch: 0, writerId: 'writer', dispatchId: 'dispatch', commit, checksDigest: 'a'.repeat(64) },
    checks: [{ id: 'test', kind: 'test', command: ['node', 'check.mjs'], counter: 'node-tap' }]
  }, deps);
  assert.equal(observed.verdict, 'runner-unavailable');
  assert.equal(observed.parkReason, 'checks-runner-unavailable');
  assert.notEqual(observed.verdict, 'pass');
  assert.deepEqual(observed.results, []);
  assert.equal(invoked, 0);
  assert.deepEqual(boundaryPaths.map(path => digest(readFileSync(path))), before);
  assert.equal(git('rev-parse', 'HEAD'), commit);
  assert.equal(git('status', '--porcelain'), '');
});
