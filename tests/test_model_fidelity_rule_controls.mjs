import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const loaderUrl = new URL('../lib/model-fidelity/rule-controls-fixture.mjs', import.meta.url);
const fixtureModule = existsSync(loaderUrl) ? await import(loaderUrl.href) : null;
const loaded = fixtureModule?.loadSyntheticFixture() ?? null;
const present = loaded !== null;
const fixture = resolve(loaded ? loaded.dir : 'tests/fixtures/model-fidelity/rule-controls-04-05');
// Why: missing fixture inputs must produce an assertion, not a module loading error.
test('changed-rule and control inputs are available', () => {
  assert.ok(present, 'rule/control fixture must be present');
});
// Why: byte changes and semantic review findings must stay distinct, and unreviewed answers cannot be scored.
test('expectations cover semantic comparison and all six control labels', { skip: !present }, () => {
  const expected = loaded.expected;
  assert.equal(expected.reviewStatus, 'expected-unreviewed');
  assert.equal(expected.scoringEligible, false);
  assert.deepEqual([...new Set(expected.controls.map(c => c.result))].sort(), ['exposed', 'invalid', 'not-run', 'shadowed', 'survived', 'unreachable-within-bounds']);
  assert.equal(expected.comparisons.find(c => c.id === 'bytes-only').semanticFinding, null);
  for (const id of ['fault-exclusion', 'generation-meaning', 'death-permission', 'initial-state']) {
    const comparison = expected.comparisons.find(c => c.id === id);
    assert.equal(comparison.comparativeImprovement, 'withheld');
    assert.ok(comparison.semanticFinding && comparison.byteDifference);
  }
  const shadow = expected.controls.find(c => c.result === 'shadowed');
  assert.equal(shadow.otherGuard, 'GuardB');
  assert.equal(shadow.reachability.config, 'shadowed-reach.cfg');
  const survived = expected.controls.find(c => c.result === 'survived');
  assert.equal(survived.claimsGenerationGuardExercised, false);
  assert.equal(expected.controls.filter(c => c.result === 'invalid').length, 2);
  for (const name of readdirSync(fixture)) {
    assert.doesNotMatch(readFileSync(join(fixture, name), 'utf8'), /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|github\.com\/|@(?:gmail|protonmail)\.com|OPENAI_API_KEY|TYPESAFE_API_KEY)/i, name);
  }
});
// Why: completed bounded searches, witnesses, wrong-property failures and syntax errors are different evidence.
test('installed TLC distinguishes policy changes and control outcomes', { skip: !present }, t => {
  if (spawnSync('which', ['tlc']).status !== 0) return t.skip('TLC_NOT_RUN: installed checker unavailable');
  mkdirSync('.scratch', { recursive: true });
  const run = mkdtempSync(resolve('.scratch/mf-rule-controls-'));
  for (const [model, config, property] of [
    ['RuleComparison', 'rule-old.cfg', 'Safety'],
    ['RuleComparison', 'rule-no-replacement.cfg', null],
    ['RuleComparison', 'rule-pinned.cfg', null],
    ['RuleComparison', 'rule-forbid-death.cfg', 'Safety'],
    ['RuleComparison', 'rule-initial-two.cfg', 'Safety'],
    ['RuleComparison', 'rule-bytes-only.cfg', 'Safety'],
    ['GuardControls', 'safe.cfg', null],
    ['GuardControls', 'unsafe.cfg', 'NoStaleEffect'],
    ['GuardControls', 'shadowed.cfg', null],
    ['GuardControls', 'shadowed-reach.cfg', null],
    ['GuardControls', 'unreachable.cfg', null],
    ['GuardControls', 'unreachable-reach.cfg', null],
    ['GuardControls', 'survived.cfg', null],
    ['GuardControls', 'hazard-witness.cfg', 'NoHazard'],
    ['GuardControls', 'wrong-property.cfg', 'NoAuditLoss'],
    ['BrokenControl', 'parser-invalid.cfg', 'PARSE_ERROR'],
  ]) {
    const output = join(run, config);
    mkdirSync(output);
    const result = spawnSync('tlc', ['-workers', '1', '-config', join(fixture, config), '-metadir', output, join(fixture, `${model}.tla`)], {
      cwd: run, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    });
    const log = result.stdout + result.stderr;
    writeFileSync(join(output, 'tlc.out'), log, { flag: 'wx' });
    assert.equal(result.error, undefined, String(result.error));
    assert.match(log, /TLC2 Version/);
    if (property === 'PARSE_ERROR') {
      assert.notEqual(result.status, 0, log);
      assert.match(log, /Parse Error|Parsing or semantic analysis failed/);
      assert.doesNotMatch(log, /Invariant NoStaleEffect is violated/);
    } else if (property) {
      assert.equal(result.status, 12, log);
      assert.ok(log.includes(`Invariant ${property} is violated`), log);
    } else {
      assert.equal(result.status, 0, log);
      assert.match(log, /Model checking completed\. No error has been found/);
      assert.match(log, /0 states left on queue/);
    }
    t.diagnostic(`${config}: ${log.match(/TLC2 Version[^\n]*/)?.[0]}; exit ${result.status}; ${log.match(/\d+ states generated[^\n]*/)?.[0] ?? 'parse failure'}; output ${output}`);
  }
});
