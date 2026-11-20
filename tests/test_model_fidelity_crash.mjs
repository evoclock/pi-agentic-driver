import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';

const fixture = resolve('tests/fixtures/model-fidelity/crash-disconnect-01');
const scratch = resolve('.scratch');
// Why: shareable synthetic fixtures must never contain private evidence or become scored answers without review.
test('synthetic fixture has no private paths or identities and is not scored before review', () => {
  assert.ok(existsSync(join(fixture, 'expected.json')), 'crash fixture must be present');
  const expected = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
  assert.equal(expected.reviewStatus, 'expected-unreviewed');
  assert.equal(expected.scoringEligible, false);
  assert.deepEqual(expected.cases.map(({ config }) => config), ['unsafe.cfg', 'safe.cfg', 'safe.cfg']);
  for (const name of readdirSync(fixture)) {
    const text = readFileSync(join(fixture, name), 'utf8');
    assert.doesNotMatch(text, /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|github\.com\/|@(?:gmail|protonmail)\.com|OPENAI_API_KEY|TYPESAFE_API_KEY)/i, name);
  }
});

// Why: the same safety invariant must expose replacement effects while allowing post-death same-generation work.
test('installed TLC finds the stale effect and accepts the guarded variant', (t) => {
  const available = spawnSync('which', ['tlc'], { encoding: 'utf8' });
  if (available.status !== 0) {
    t.diagnostic('TLC_NOT_RUN: checker absent; fixture privacy check still ran');
    t.skip('TLC_NOT_RUN: installed checker unavailable');
    return;
  }
  mkdirSync(scratch, { recursive: true });
  const runDir = mkdtempSync(join(scratch, 'mf-crash-tlc-'));
  for (const [config, shouldFail] of [['unsafe.cfg', true], ['safe.cfg', false]]) {
    const output = join(runDir, config.replace('.cfg', ''));
    mkdirSync(output);
    const result = spawnSync('tlc', ['-workers', '1', '-config', join(fixture, config), '-metadir', output, join(fixture, 'CrashReadiness.tla')], {
      cwd: runDir, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    });
    const log = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${config}: ${result.error}`);
    const checkerVersion = log.match(/TLC2 Version [^\n]+/)?.[0];
    assert.ok(checkerVersion, `${config}: checker version missing: ${log}`);
    t.diagnostic(checkerVersion);
    if (shouldFail) {
      assert.notEqual(result.status, 0, log);
      assert.match(log, /Invariant NoStaleEffect is violated/);
      assert.match(log, /State 5: <ApplyClearedEffect/);
    } else {
      assert.equal(result.status, 0, log);
      assert.match(log, /Model checking completed\. No error has been found/);
    }
    t.diagnostic(`${config}: exit ${result.status}; ${log.match(/\d+ states generated[^\n]*/)?.[0]}`);
  }
});
