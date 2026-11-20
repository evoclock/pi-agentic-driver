import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Why: an uncovered new model must fail and a resolved historical exception must be removed.
test('inventory rejects uncovered and stale exceptions in a scratch repository', async () => {
  assert.ok(existsSync('scripts/model_negative_controls.mjs'), 'negative coverage checker must exist');
  const { auditModels } = await import('../scripts/model_negative_controls.mjs');
  mkdirSync('.scratch',{recursive:true});
  const root = mkdtempSync(resolve('.scratch/model-inventory-'));
  try {
    mkdirSync(join(root,'docs'),{recursive:true});
    writeFileSync(join(root,'docs/Example.tla'),'---- MODULE Example ----\n====');
    writeFileSync(join(root,'docs/Example.cfg'),'INVARIANT Safe');
    writeFileSync(join(root,'docs/Example-unsafe-safe.cfg'),'INVARIANT Safe');
    const base = {root,controls:{},allowlist:{}};
    assert.match(auditModels(base).errors.join('\n'),/missing negative controls: Safe/);
    const controls = {'docs/Example.tla':[{config:'Example-unsafe-safe.cfg',expected:'Safe'}]};
    assert.deepEqual(auditModels({...base,controls}).errors,[]);
    const allowlist = {'docs/Example.tla':{reason:'historical gap',missing:['Safe']}};
    assert.match(auditModels({...base,controls,allowlist}).errors.join('\n'),/covered model must leave allowlist/);
    assert.match(auditModels({...base,allowlist:{'docs/Absent.tla':{reason:'old',missing:['Safe']}}}).errors.join('\n'),/stale model inventory entry/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

// Why: historical exceptions can only shrink relative to the merged configuration.
test('allowlist cannot gain models or missing obligations', async () => {
  const module = await import('../scripts/model_negative_controls.mjs');
  assert.equal(typeof module.allowlistGrowth, 'function', 'monotonic allowlist check must exist');
  const old = {model:{reason:'old gap',missing:['Safe','Live']}};
  assert.deepEqual(module.allowlistGrowth(old,{model:{reason:'old gap',missing:['Safe']}}),[]);
  assert.deepEqual(module.allowlistGrowth(old,{}),[]);
  assert.ok(module.allowlistGrowth(old,{model:{reason:'gap',missing:['New']}}).length);
  assert.ok(module.allowlistGrowth(old,{other:{reason:'gap',missing:['Safe']}}).length);
});

// Why: listing an invariant in an unsafe config does not prove that it is falsified.
test('coverage requires a named negative result for every checked obligation', async () => {
  assert.ok(existsSync('scripts/model_negative_controls.mjs'), 'negative coverage checker must exist');
  const { coverageGaps } = await import('../scripts/model_negative_controls.mjs');
  assert.deepEqual(coverageGaps(['Safe','Live'], [{expected:'Safe'}]), ['Live']);
  assert.deepEqual(coverageGaps(['Safe'], [{expected:'Other'}]), ['Safe']);
  assert.deepEqual(coverageGaps(['Safe'], [{expected:'Safe'}]), []);
});

// Why: same-line directives must not be mistaken for additional invariant names.
test('standalone directives and joined identifiers stay distinct over 80 forms', async () => {
  assert.ok(existsSync('scripts/model_negative_controls.mjs'), 'negative coverage checker must exist');
  const { obligations, DIRECTIVES } = await import('../scripts/model_negative_controls.mjs');
  assert.equal(DIRECTIVES.length, 16);
  for (const directive of DIRECTIVES) for (const whitespace of [' ', '\t', '\n', '\r\n', '']) {
    assert.equal(obligations(`INVARIANT Safe${whitespace}${directive} Bound`)[0], whitespace ? 'Safe' : `Safe${directive}`);
    assert.ok(!obligations(`INVARIANT Safe${whitespace}${directive} Bound`).includes(directive));
  }
});

function probeFixture(operation) {
  mkdirSync('.scratch', {recursive:true});
  const root = mkdtempSync(resolve('.scratch/probe-inventory-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/Example.tla'), '---- MODULE Example ----\n====');
  writeFileSync(join(root, 'docs/Example.cfg'), 'INVARIANT Safe');
  writeFileSync(join(root, 'docs/Example-unsafe-safe.cfg'), 'INVARIANT Safe');
  writeFileSync(join(root, 'docs/Example-probe-target.cfg'), 'INVARIANT NeverTarget');
  const safety = {config:'Example-unsafe-safe.cfg', expected:'Safe', kind:'invariant'};
  const probe = {config:'Example-probe-target.cfg', expected:'NeverTarget', kind:'reachability'};
  try { return operation({root, safety, probe}); }
  finally { rmSync(root, {recursive:true, force:true}); }
}

// Why: a reachability witness must never disappear from checked inventory.
test('probe inventory rejects unregistered sentinels and accepts checked category', async () => {
  const {auditModels} = await import('../scripts/model_negative_controls.mjs');
  probeFixture(({root, safety, probe}) => {
    const audit = entries => auditModels({root, controls:{'docs/Example.tla':entries}, allowlist:{}});
    assert.match(audit([safety]).errors.join('\n'), /unregistered probe/);
    const valid = audit([safety, probe]);
    assert.deepEqual(valid.errors, []);
    assert.deepEqual(valid.models[0].cfgs, ['Example.cfg']);
    assert.match(audit([probe]).errors.join('\n'), /missing negative controls: Safe/);
    assert.match(audit([safety, {...probe, config:safety.config}]).errors.join('\n'), /invalid reachability control/);
    assert.match(audit([safety, {...probe, expected:'Safe'}]).errors.join('\n'), /invalid reachability control/);
    assert.match(audit([safety, {...probe, kind:'invariant'}]).errors.join('\n'), /invalid negative control/);
  });
});

// Why: a later probe marker must not fall between positive exclusion and probe discovery.
test('later-marker probes require registration and stay excluded from positives', async () => {
  const {auditModels} = await import('../scripts/model_negative_controls.mjs');
  probeFixture(({root, safety, probe}) => {
    const config = 'Example-branch-probe-target.cfg';
    renameSync(join(root, 'docs', probe.config), join(root, 'docs', config));
    const audit = entries => auditModels({root, controls:{'docs/Example.tla':entries}, allowlist:{}});
    assert.match(audit([safety]).errors.join('\n'), /unregistered probe Example-branch-probe-target.cfg: NeverTarget/);
    const valid = audit([safety, {...probe, config}]);
    assert.deepEqual(valid.errors, []);
    assert.deepEqual(valid.models[0].cfgs, ['Example.cfg']);
    assert.match(audit([{...probe, config}]).errors.join('\n'), /missing negative controls: Safe/);
  });
});

// Why: passing liveness checks must remain inventoried positives, not non-sentinel probes.
test('main-style liveness probe is rejected and its renamed positive requires a property control', async () => {
  const {auditModels} = await import('../scripts/model_negative_controls.mjs');
  probeFixture(({root, safety, probe}) => {
    writeFileSync(join(root, 'docs', probe.config), 'INVARIANT Safe\nPROPERTY NoStarvation');
    writeFileSync(join(root, 'docs/Example-unsafe-starve.cfg'), 'PROPERTY NoStarvation');
    const property = {config:'Example-unsafe-starve.cfg', expected:'NoStarvation', kind:'property'};
    const audit = entries => auditModels({root, controls:{'docs/Example.tla':entries}, allowlist:{}});
    assert.match(audit([safety, property]).errors.join('\n'), /probe has no sentinel/);
    renameSync(join(root, 'docs', probe.config), join(root, 'docs/Example-liveness.cfg'));
    assert.match(audit([safety]).errors.join('\n'), /missing negative controls: NoStarvation/);
    const valid = audit([safety, property]);
    assert.deepEqual(valid.errors, []);
    assert.deepEqual(valid.models[0].cfgs, ['Example-liveness.cfg', 'Example.cfg']);
  });
  assert.ok(existsSync('docs/design/verify/ParallelScheduler-liveness.cfg'), 'scheduler liveness remains checked under a positive filename');
});

// Why: an unreachable target, wrong rule, crash or temporal failure is not a reachability witness.
test('reachability results require the exact named invariant and exit twelve', async () => {
  const {negativeResultMatches} = await import('../scripts/model_negative_controls.mjs');
  const control = {kind:'reachability', expected:'NeverTarget'};
  assert.equal(negativeResultMatches(control, {status:12, stdout:'Invariant NeverTarget is violated'}), true);
  for (const run of [{status:0, stdout:'No error has been found'}, {status:12, stdout:'Invariant Other is violated'}, {status:13, stdout:'Temporal property NeverTarget is violated'}, {status:1, stdout:'Invariant NeverTarget is violated'}]) {
    assert.equal(negativeResultMatches(control, run), false);
  }
  assert.deepEqual((await import('../scripts/model_negative_controls.mjs')).coverageGaps(['Safe'], [{kind:'reachability', expected:'Safe'}]), ['Safe']);
});

// Why: an unlabeled TLC lasso is attributed only to a sole, unambiguous configured property.
test('temporal attribution requires sole property, no invariants, exit thirteen and error trace', async () => {
  const {negativeResultMatches} = await import('../scripts/model_negative_controls.mjs');
  // Exact error-trace excerpt from the real TLC 2.19 Settles control, 11/7 states.
  const run = {status:13, stdout:'Error: Temporal properties were violated.\n\nError: The following behavior constitutes a counter-example:\n\nState 1: <Initial predicate>\n/\\ reviewed = FALSE\n'};
  // Keep the baseline self-contained: the complete recorded trace is a new fixture, absent on base.
  const control = {kind:'property', expected:'Settles'};
  for (const config of ['PROPERTY Settles', 'PROPERTIES Settles', 'PROPERTY Settles\n\\* PROPERTY Other\n(* INVARIANT Safe *)']) {
    assert.equal(negativeResultMatches(control, run, config), true);
  }
  for (const config of ['', 'PROPERTY Other', 'PROPERTIES Settles Other', 'PROPERTIES Settles Settles', 'PROPERTY Settles\nPROPERTY Settles', 'PROPERTY Settles\nPROPERTY Other', 'PROPERTY Settles\nINVARIANT Safe', 'PROPERTY Settles\nINVARIANTS Safe Other', '\\* PROPERTY Settles', 'CONSTANT Text = "PROPERTY Settles"']) {
    assert.equal(negativeResultMatches(control, run, config), false);
  }
  for (const status of [0, 1, 12, null]) assert.equal(negativeResultMatches(control, {...run, status}, 'PROPERTY Settles'), false);
  for (const stdout of ['Temporal properties were violated.', 'State 1: <Initial predicate>', run.stdout.replace('Temporal properties were violated.', ''), run.stdout.replace(/State \d+:/g, '')]) {
    assert.equal(negativeResultMatches(control, {...run, stdout}, 'PROPERTY Settles'), false);
  }
});

// Why: historical exceptions cannot hide newly covered models or stale inventory entries.
test('model negative-control inventory is current', async () => {
  assert.ok(existsSync('scripts/model_negative_controls.mjs'), 'negative coverage checker must exist');
  const { auditModels } = await import('../scripts/model_negative_controls.mjs');
  assert.deepEqual(auditModels().errors, []);
});
