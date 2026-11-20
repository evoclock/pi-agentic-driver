import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

async function loadRetention() {
  const module = await import('../lib/model-fidelity/retention.mjs').catch(() => null);
  assert.ok(module, 'retention module must exist');
  return module.retentionDestination;
}

// Why: a missing destination must not silently claim durable retention.
test('default store stays local and labelled non-durable', async () => {
  const retentionDestination = await loadRetention();
  assert.deepEqual(retentionDestination({ repo: '/project' }), {
    root: '/project/.scratch/model-fidelity', retention: 'local-non-durable', publication: 'none',
  });
});

// Why: selecting a path alone cannot prove a private Git push occurred.
test('explicit destination is configured but not claimed verified or published', async () => {
  const retentionDestination = await loadRetention();
  assert.deepEqual(retentionDestination({ repo: '/project', destination: '/private/evidence' }), {
    root: '/private/evidence', retention: 'configured-unverified', publication: 'none',
  });
  assert.throws(() => retentionDestination({ repo: '/project', destination: 'relative' }), /absolute/);
});

// Why: a verified private Git destination must retain distinct attempts without replacing an existing bundle.
test('append-only retention pushes one bundle to a local bare Git fixture and refuses conflicts', async () => {
  const { appendRetentionBundle } = await import('../lib/model-fidelity/retention.mjs');
  assert.equal(typeof appendRetentionBundle, 'function', 'append operation must exist');
  const scratch = path.resolve(fileURLToPath(new URL('../.scratch/', import.meta.url)));
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, 'retention-fixture-'));
  const bare = path.join(root, 'evidence.git');
  const checkout = path.join(root, 'checkout');
  const bundle = path.join(root, 'capture');
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(['init', '--bare', bare]);
  git(['clone', bare, checkout]);
  git(['config', 'user.name', 'Fixture Author'], checkout);
  git(['config', 'user.email', 'fixture@example.invalid'], checkout);
  git(['checkout', '-b', 'main'], checkout);
  writeFileSync(path.join(checkout, 'README.md'), 'fixture only\n');
  git(['add', 'README.md'], checkout);
  git(['commit', '-m', 'Initialize fixture'], checkout);
  git(['push', '-u', 'origin', 'main'], checkout);
  mkdirSync(bundle);
  writeFileSync(path.join(bundle, 'result.json'), '{"outcome":"failed attempt"}\n');
  writeFileSync(path.join(bundle, 'manifest.json'), '{"id":"attempt-01"}\n');
  const verifyDestination = origin => origin === bare;
  const options = { bundle, destination: checkout, planId: 'plan-01', bundleId: 'attempt-01', verifyDestination };
  assert.throws(() => appendRetentionBundle({ ...options, verifyDestination: () => false }), /not verified/);
  const before = git(['rev-parse', 'HEAD'], checkout);
  const result = appendRetentionBundle(options);
  assert.equal(result.publication, 'pushed');
  assert.notEqual(result.head, before);
  assert.equal(git(['rev-parse', 'refs/heads/main'], bare), result.head);
  assert.equal(git(['show', `main:${result.relative}/result.json`], bare), '{"outcome":"failed attempt"}');
  assert.equal(readFileSync(path.join(checkout, result.relative, 'result.json'), 'utf8'), '{"outcome":"failed attempt"}\n');
  assert.throws(() => appendRetentionBundle(options), /EEXIST/);
  assert.equal(git(['rev-parse', 'HEAD'], checkout), result.head);
  assert.equal(git(['rev-parse', 'refs/heads/main'], bare), result.head);
});

// Why: agent hosts need an inspectable result without hidden input or interaction.
test('closed-input CLI exposes both modes as JSON', () => {
  const cli = new URL('../scripts/model_fidelity_retention.mjs', import.meta.url).pathname;
  const localRun = spawnSync(process.execPath, [cli, '--repo', '/project'], { input: '' });
  assert.equal(localRun.status, 0, 'default CLI succeeds');
  assert.equal(JSON.parse(localRun.stdout).retention, 'local-non-durable');
  const configuredRun = spawnSync(process.execPath, [cli, '--repo', '/project', '--destination', '/private/evidence'], { input: '' });
  assert.equal(configuredRun.status, 0, 'configured CLI succeeds');
  assert.equal(JSON.parse(configuredRun.stdout).retention, 'configured-unverified');
  const invalid = spawnSync(process.execPath, [cli, '--repo', '/project', '--destination', 'relative'], { input: '' });
  assert.equal(invalid.status, 2);
  assert.ok(JSON.parse(invalid.stdout).error);
});
