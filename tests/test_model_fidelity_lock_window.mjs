import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const loaded = existsSync(new URL('../lib/model-fidelity/lock-window-fixture.mjs', import.meta.url))
  ? (await import('../lib/model-fidelity/lock-window-fixture.mjs')).loadSyntheticFixture()
  : null;
const present = loaded !== null;
const fixture = loaded ? loaded.dir : resolve('tests/fixtures/model-fidelity/lock-window-03');
// Why: the workflow needs complete inputs, with missing fixtures detected as an assertion.
test('lock-window fixture is available', () => {
  assert.ok(present, 'lock-window fixture must be present');
});
// Why: expected answers disclose the unprotected interval and never substitute for independent review.
test('lock-window expectations preserve the rule and proposed map', { skip: !present }, () => {
  const expected = loaded.expected;
  assert.equal(expected.reviewStatus, 'expected-unreviewed');
  assert.equal(expected.scoringEligible, false);
  assert.equal(expected.cases.length, 6);
  const map = loaded.operations;
  assert.match(map.unprotectedInterval, /ReadIdentity.*ApplyEffect/);
  assert.deepEqual(map.actions.map(a => a.actionId), ['ClientDies', 'ObserveLock', 'BackendDies', 'ReadMetadata', 'ReadIdentity', 'ReplaceResource', 'PublishGeneration', 'ApplyEffect', 'RejectEffect']);
  for (const entry of expected.cases) assert.ok(entry.actionId && entry.mechanism && entry.schedule.length && entry.expectedOutcome);
  for (const name of readdirSync(fixture)) {
    assert.doesNotMatch(readFileSync(join(fixture, name), 'utf8'), /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|github\.com\/|@(?:gmail|protonmail)\.com|OPENAI_API_KEY|TYPESAFE_API_KEY)/i, name);
  }
});
// Why: all variants must use the same stale-generation rule, including safe post-death completion.
test('installed TLC distinguishes guarded effects from snapshot and pin near-misses', { skip: !present }, t => {
  if (spawnSync('which', ['tlc']).status !== 0) return t.skip('TLC_NOT_RUN: installed checker unavailable');
  mkdirSync('.scratch', { recursive: true });
  const run = mkdtempSync(resolve('.scratch/mf-lock-window-'));
  for (const [config, property, action] of [
    ['unsafe.cfg', 'NoStaleEffect', 'ApplyEffect'],
    ['token-only.cfg', 'NoStaleEffect', 'ApplyEffect'],
    ['immutable-pin.cfg', 'NoStaleEffect', 'ApplyEffect'],
    ['safe.cfg', null, null],
    ['service-check.cfg', null, null],
    ['completion-witness.cfg', 'NoCompletion', 'ApplyEffect'],
  ]) {
    const output = join(run, config);
    mkdirSync(output);
    const result = spawnSync('tlc', ['-workers', '1', '-config', join(fixture, config), '-metadir', output, join(fixture, 'LockWindow.tla')], {
      cwd: run, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    });
    const log = result.stdout + result.stderr;
    writeFileSync(join(output, 'tlc.out'), log, { flag: 'wx' });
    assert.equal(result.error, undefined, String(result.error));
    assert.match(log, /TLC2 Version/);
    if (property) {
      assert.equal(result.status, 12, log);
      assert.ok(log.includes(`Invariant ${property} is violated`), log);
      assert.ok(log.includes(`<${action} `), log);
      assert.ok(log.includes('<ClientDies ') && log.includes('<BackendDies '), log);
    } else {
      assert.equal(result.status, 0, log);
      assert.match(log, /Model checking completed\. No error has been found/);
    }
    t.diagnostic(`${config}: ${log.match(/TLC2 Version[^\n]*/)?.[0]}; exit ${result.status}; ${log.match(/\d+ states generated[^\n]*/)?.[0]}; output ${output}`);
  }
});
