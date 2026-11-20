import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const loaderUrl = new URL('../lib/model-fidelity/disconnect-fixture.mjs', import.meta.url);
const fixtureModule = existsSync(loaderUrl) ? await import(loaderUrl.href) : null;
const loaded = fixtureModule?.loadSyntheticFixture() ?? null;
const present = loaded !== null;
const fixture = resolve(loaded ? loaded.dir : 'tests/fixtures/model-fidelity/disconnect-02');
// Why: absence is an assertion failure rather than a missing-file crash during fail-first.
test('disconnect fixture is available to workflow callers', () => {
  assert.ok(present, 'disconnect fixture must be present');
});
// Why: synthetic inputs must not publish private evidence or score unreviewed judgments.
test('disconnect expectations and operation map preserve the synthetic boundary', { skip: !present }, () => {
  const expected = loaded.expected;
  assert.equal(expected.reviewStatus, 'expected-unreviewed');
  assert.equal(expected.scoringEligible, false);
  assert.equal(expected.cases.length, 5);
  for (const entry of expected.cases) {
    assert.ok(entry.actionId && entry.mechanism && entry.schedule.length && entry.expectedOutcome);
  }
  const map = loaded.operations;
  assert.equal(map.actions.find(a => a.actionId === 'RevokeCapability').actor, 'surviving-revoker');
  assert.equal(map.actions.find(a => a.actionId === 'Disconnect').durableWrite, false);
  for (const name of readdirSync(fixture)) {
    assert.doesNotMatch(readFileSync(join(fixture, name), 'utf8'), /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|github\.com\/|@(?:gmail|protonmail)\.com|OPENAI_API_KEY|TYPESAFE_API_KEY)/i, name);
  }
});
// Why: actual bounded runs distinguish stale effects, safe completion, and impossible disconnect cleanup.
test('installed TLC checks disconnect fixture cases', { skip: !present }, t => {
  if (spawnSync('which', ['tlc']).status !== 0) return t.skip('TLC_NOT_RUN: installed checker unavailable');
  mkdirSync('.scratch', { recursive: true });
  const run = mkdtempSync(resolve('.scratch/mf-disconnect-'));
  for (const [config, property, action] of [
    ['unsafe.cfg', 'NoStaleEffect', 'ApplyEffect'],
    ['safe.cfg', null, null],
    ['fictional-cleanup.cfg', 'NoDisconnectedWrite', 'Disconnect'],
    ['same-generation-witness.cfg', 'NoPostDisconnectCompletion', 'ApplyEffect'],
    ['revoker-witness.cfg', 'NoRevocation', 'RevokeCapability'],
  ]) {
    const output = join(run, config);
    mkdirSync(output);
    const result = spawnSync('tlc', ['-workers', '1', '-config', join(fixture, config), '-metadir', output, join(fixture, 'DisconnectCapability.tla')], {
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
    } else {
      assert.equal(result.status, 0, log);
      assert.match(log, /Model checking completed\. No error has been found/);
    }
    t.diagnostic(`${config}: ${log.match(/TLC2 Version[^\n]*/)?.[0]}; exit ${result.status}; ${log.match(/\d+ states generated[^\n]*/)?.[0]}; output ${output}`);
  }
});
