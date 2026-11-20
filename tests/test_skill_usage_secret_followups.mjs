// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadProviderCredential } from '../scripts/credential_store.mjs';

// Why: An explicitly enabled local check must round-trip only its own disposable fake item through production lookup.
test('opt-in macOS fake-item Keychain round-trip', {
  skip: process.platform !== 'darwin' || process.env.PAD_KEYCHAIN_SELFTEST !== '1' || process.env.CI !== undefined,
}, async () => {
  const service = `pad-selftest-${randomUUID()}`;
  const account = 'pad-selftest';
  const value = randomBytes(32).toString('hex');
  function security(args) {
    const result = spawnSync('/usr/bin/security', args, { env: {}, stdio: 'ignore', timeout: 5000 });
    assert.ok(!result.error && result.status === 0,
      'fake-item Keychain operation failed or timed out; stop and check for an interactive prompt');
  }
  try {
    security(['add-generic-password', '-s', service, '-a', account, '-w', value]);
    const result = await loadProviderCredential('openai', { env: {}, platform: 'darwin',
      userConfig: { secrets: { openai: { service, account } } } });
    assert.ok(result.key === value, 'fake-item Keychain value did not round-trip');
  } finally {
    security(['delete-generic-password', '-s', service, '-a', account]);
  }
});

const config = { secrets: { openai: { service: '<OPENAI_KEYCHAIN_SERVICE>', account: '<OPENAI_KEYCHAIN_ACCOUNT>' } } };
const candidates = ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool', '<OWNER_HOME>/.nix-profile/bin/secret-tool'];
function fixture(found = candidates[0]) {
  const calls = [], probes = [], warnings = [];
  return { calls, probes, warnings, deps: {
    platform: 'linux', env: { HOME: '<OWNER_HOME>', PATH: '<UNTRUSTED_PATH>' }, userConfig: config,
    stat: async () => { throw new Error('absent'); },
    probeExecutable: async (path) => { probes.push(path); return path === found; },
    stderr: { write: (text) => warnings.push(text) },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => { child.stdout.end('synthetic-key\n'); child.stderr.end(); child.emit('close', 0); });
      return child;
    },
  } };
}

// Why: Never consult PATH or spawn a bare executable; stop at the first eligible absolute candidate.
test('Linux selects first executable candidate and ignores PATH', async () => {
  for (const [index, path] of candidates.entries()) {
    const f = fixture(path);
    assert.deepEqual(await loadProviderCredential('openai', f.deps), { key: 'synthetic-key' });
    assert.equal(f.calls[0].command, path);
    assert.deepEqual(f.probes, candidates.slice(0, index + 1));
    assert.deepEqual(f.calls[0].options.env, {});
  }
});

// Why: Missing tools must fail without running an attacker-controlled PATH entry and list every attempted path.
test('Linux missing executable lists candidates in order without spawning', async () => {
  const f = fixture(null);
  await assert.rejects(loadProviderCredential('openai', f.deps), (error) => {
    assert.ok(error.message.includes(candidates.join(', ')));
    assert.ok(!error.message.includes('<UNTRUSTED_PATH>'));
    return true;
  });
  assert.deepEqual(f.probes, candidates); assert.equal(f.calls.length, 0);
});

// Why: A broken config cannot block an explicitly selected file, while a valid store still retains precedence.
test('explicit file survives malformed unreadable and missing config for both providers', async () => {
  for (const provider of ['openai', 'typesafe']) {
    for (const failure of ['malformed', 'unreadable', 'missing']) {
      const f = fixture(); delete f.deps.userConfig;
      const variable = `${provider.toUpperCase()}_API_KEY_FILE`;
      f.deps.env[variable] = ' <KEY_FILE> ';
      f.deps.env.PAD_USER_CONFIG = '<USER_CONFIG>';
      f.deps.readFile = async (path) => {
        assert.equal(path, '<KEY_FILE>');
        return ' synthetic-key\n';
      };
      f.deps.readConfigFile = () => {
        if (failure === 'malformed') return '{';
        throw Object.assign(new Error('private-detail'), { code: failure === 'missing' ? 'ENOENT' : 'EACCES' });
      };
      let result;
      await assert.doesNotReject(async () => { result = await loadProviderCredential(provider, f.deps); },
        'explicit file must survive config load failure');
      assert.deepEqual(result, { key: 'synthetic-key' });
      assert.deepEqual(f.warnings, [`warning: using ${variable}; prefer the OS secret store\n`]);
      assert.equal(f.calls.length, 0);
    }
  }
});

// Why: Suppressing a config error without an explicit file would hide misconfiguration rather than fail closed.
test('broken config without explicit file remains a public failure', async () => {
  const f = fixture(); delete f.deps.userConfig;
  f.deps.env.PAD_USER_CONFIG = '<USER_CONFIG>';
  f.deps.readConfigFile = () => '{';
  await assert.rejects(loadProviderCredential('openai', f.deps), { message: 'Invalid user config' });
  assert.equal(f.calls.length, 0);
});

// Why: Both entry points must teach session requirements and a complete migration instead of implicit file discovery.
test('credential docs include scheduler caveats and migration steps', async () => {
  for (const path of ['docs/skill-usage-eval.md', 'skills/skill-usage-eval/SKILL.md']) {
    const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    for (const keyword of ['## Scheduled jobs', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'systemd user', 'cron',
      'launchd', 'login session', '## Migrate an existing key file', 'security add-generic-password',
      'secret-tool store --label=', '<USER_CONFIG>', 'rm', 'verify']) assert.ok(text.includes(keyword), `${path}: ${keyword}`);
  }
});
