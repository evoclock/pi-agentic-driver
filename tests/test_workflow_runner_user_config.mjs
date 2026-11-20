// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function helper() {
  const url = new URL('../scripts/workflow_runner_user_config.mjs', import.meta.url);
  assert.equal(await access(url).then(() => true, () => false), true, 'shared user-config loader must exist');
  const load = (await import(url.href)).loadUserConfig;
  return options => {
    const result = load(options);
    if (result && typeof result.then === 'function') { result.catch(() => {}); assert.fail('shared user-config loading must be synchronous'); }
    return result;
  };
}
const absent = () => { throw Object.assign(new Error('private detail'), { code: 'ENOENT' }); };

// Why: Config selection must respect explicit override, XDG and injected HOME without inspecting the real home.
test('user config lookup order and missing defaults', async () => {
  const load = await helper();
  for (const [env, expected] of [
    [{ HOME: '<OWNER_HOME>', PAD_USER_CONFIG: '<USER_CONFIG>', XDG_CONFIG_HOME: '<XDG_CONFIG>' }, '<USER_CONFIG>'],
    [{ HOME: '<OWNER_HOME>', XDG_CONFIG_HOME: '<XDG_CONFIG>' }, '<XDG_CONFIG>/pad/user.v1.json'],
    [{ HOME: '<OWNER_HOME>' }, '<OWNER_HOME>/.config/pad/user.v1.json'],
  ]) {
    const paths = [];
    const value = await load({ env, readFile: (path) => { paths.push(path); return absent(); } });
    assert.deepEqual(paths, [expected]);
    assert.deepEqual(value, { schema: 'pad-user.v1', checks: { runner: 'auto' }, secrets: {},
      progress: { noProgressLimit: 3, safetyCeiling: 50 }, attempts: { max: 2 }, model: { policy: 'subscription' } });
  }
});

// Why: All section-5.6 keys must survive closed validation and supplied ceilings must stay bounded.
test('user config validates every section 5.6 key', async () => {
  const load = await helper();
  const input = { schema: 'pad-user.v1', checks: { runner: 'macos', macos: { image: '<REVIEWED_CONTAINER_IMAGE>', cpus: 2, memory: '4G' } },
    secrets: { openai: { service: '<OPENAI_KEYCHAIN_SERVICE>', account: '<OPENAI_KEYCHAIN_ACCOUNT>' },
      typesafe: { service: '<TYPESAFE_KEYCHAIN_SERVICE>', account: '<TYPESAFE_KEYCHAIN_ACCOUNT>' } },
    progress: { noProgressLimit: 3, safetyCeiling: 50 }, attempts: { max: 2 }, model: { policy: 'local', localRoute: '<LOCAL_MODEL_ROUTE>' } };
  assert.deepEqual(await load({ env: { PAD_USER_CONFIG: '<USER_CONFIG>' }, readFile: () => JSON.stringify(input) }), input);
});

// Why: Broken or unknown configuration must fail closed with public errors instead of silently defaulting or leaking content.
test('user config rejects unknown keys invalid values and unreadable files privately', async () => {
  const load = await helper();
  for (const text of ['sk-test-SYNTHETIC-NEVER-REAL-keyfile', 'null', '[]', '{}',
    ...[{ extra: true }, { checks: { runner: 'other' } }, { checks: { macos: { extra: true } } },
      { secrets: { other: {} } }, { secrets: { openai: { service: 7 } } },
      { secrets: { openai: { value: 'sk-test-SYNTHETIC-NEVER-REAL-keyfile' } } },
 { attempts: { max: 0 } }, { model: { policy: 'other' } },
      { model: { localRoute: 3 } }, { checks: { macos: { cpus: 0 } } },
      { checks: { macos: { memory: [] } } }, { progress: { noProgressLimit: 1.5 } },
      { checks: null }, { model: { extra: true } }, { model: { policy: 'local' } },
      { model: { policy: 'local-fallback', localRoute: ' ' } }, { secrets: { openai: { service: '<OPENAI_KEYCHAIN_SERVICE>' } } },
      { secrets: { typesafe: { account: '<TYPESAFE_KEYCHAIN_ACCOUNT>' } } }].map((value) => JSON.stringify({ schema: 'pad-user.v1', ...value }))]) {
    await assert.rejects(async () => load({ env: { PAD_USER_CONFIG: '<USER_CONFIG>' }, readFile: () => text }),
      (e) => { assert.equal(e.message, 'Invalid user config'); return true; });
  }
  for (const [input, key, maximum] of [[{ progress: { noProgressLimit: 21 } }, 'noProgressLimit', 20], [{ progress: { safetyCeiling: 1001 } }, 'safetyCeiling', 1000], [{ attempts: { max: 101 } }, 'max', 100]]) {
    const result = load({ env: { PAD_USER_CONFIG: '<USER_CONFIG>' }, readFile: () => JSON.stringify({ schema: 'pad-user.v1', ...input }) });
    assert.equal((input.progress ? result.progress : result.attempts)[key], maximum);
  }
  await assert.rejects(async () => load({ env: { PAD_USER_CONFIG: '<USER_CONFIG>' }, readFile: () => { throw new Error('private detail'); } }), /User config unavailable/);
});

// Why: Partial sections must keep the remaining defaults rather than replacing the whole section.
test('user config merges partial sections over defaults', async () => {
  const load = await helper();
  const value = await load({ env: { PAD_USER_CONFIG: '<USER_CONFIG>' }, readFile: () => JSON.stringify(
    { schema: 'pad-user.v1', progress: { noProgressLimit: 5 }, model: { localRoute: '<LOCAL_MODEL_ROUTE>' } }) });
  assert.deepEqual(value.progress, { noProgressLimit: 5, safetyCeiling: 50 });
  assert.deepEqual(value.model, { policy: 'subscription', localRoute: '<LOCAL_MODEL_ROUTE>' });
  assert.deepEqual(value.attempts, { max: 2 }); assert.deepEqual(value.checks, { runner: 'auto' });
});

// Why: The default reader must accept only regular files; a directory at the config path fails closed, a missing path defaults.
test('default reader requires a regular file in an isolated HOME', async () => {
  const load = await helper();
  await mkdir('.scratch', { recursive: true });
  const home = await mkdtemp(resolve('.scratch/user-config-'));
  try {
    const env = { HOME: home };
    assert.equal((await load({ env })).schema, 'pad-user.v1');
    const dir = join(home, '.config', 'pad');
    await mkdir(join(dir, 'user.v1.json'), { recursive: true });
    await assert.rejects(async () => load({ env }), (e) => { assert.equal(e.message, 'User config unavailable'); return true; });
    // A device is not a regular file: it must be refused before reading, not parsed as empty JSON.
    if (process.platform !== 'win32') await assert.rejects(async () => load({ env: { ...env, PAD_USER_CONFIG: '/dev/null' } }),
      (e) => { assert.equal(e.message, 'User config unavailable'); return true; });
    const file = join(home, 'user.json');
    await writeFile(file, JSON.stringify({ schema: 'pad-user.v1', attempts: { max: 4 } }));
    assert.deepEqual((await load({ env: { ...env, PAD_USER_CONFIG: file } })).attempts, { max: 4 });
  } finally { await rm(home, { recursive: true, force: true }); }
});
import { existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
const modulePath = new URL('../scripts/workflow_runner_user_config.mjs', import.meta.url);
const api = existsSync(modulePath) ? await import(modulePath.href) : {};
function load(options) {
  assert.equal(typeof api.loadUserConfig, 'function', 'closed local configuration loader is not implemented');
  const result = api.loadUserConfig(options);
  if (result && typeof result.then === 'function') { result.catch(() => {}); assert.fail('shared user-config loading must be synchronous'); }
  return result;
}
// Why: a named override selects only that file, not a competing fallback or real personal configuration.
test('user config lookup honors explicit and XDG locations using injected reads', () => {
  const paths = [], readFile = path => { paths.push(path); return '{"schema":"pad-user.v1"}'; };
  load({ readFile, env: { PAD_USER_CONFIG: '<USER_CONFIG>', XDG_CONFIG_HOME: '<CONFIG_HOME>', HOME: '<OWNER_HOME>' } });
  load({ readFile, env: { XDG_CONFIG_HOME: '<CONFIG_HOME>', HOME: '<OWNER_HOME>' } });
  load({ readFile, env: { HOME: '<OWNER_HOME>' } });
  assert.deepEqual(paths, ['<USER_CONFIG>', '<CONFIG_HOME>/pad/user.v1.json', '<OWNER_HOME>/.config/pad/user.v1.json']);
});
// Why: absence permits built-in defaults, but malformed or unreadable input must fail closed.
test('missing user config uses defaults while invalid input fails closed', () => {
  const config = load({ readFile: () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); }, env: { PAD_USER_CONFIG: '<USER_CONFIG>' } });
  assert.equal(config.model.policy, 'subscription'); assert.equal(config.checks.runner, 'auto'); assert.deepEqual(config.progress, { noProgressLimit: 3, safetyCeiling: 50 }); assert.equal(config.attempts.max, 2);
  for (const bytes of ['{', '{"schema":"wrong"}', '{"schema":"pad-user.v1","secret":"not-allowed"}', '{"schema":"pad-user.v1","checks":{"runner":"other"}}', '{"schema":"pad-user.v1","model":{"policy":"local"}}']) {
    assert.throws(() => load({ readFile: () => bytes, env: { PAD_USER_CONFIG: '<USER_CONFIG>' } }), /Invalid user config/);
  }
  assert.throws(() => load({ readFile: () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); }, env: { PAD_USER_CONFIG: '<USER_CONFIG>' } }), /unavailable/);
});
// Why: local ceilings override defaults but can never exceed the engine safety backstops.
test('user config numeric limits clamp to engine backstops and reject inverted progress', () => {
  const env = { PAD_USER_CONFIG: '<USER_CONFIG>' };
  const config = load({ env, readFile: () => JSON.stringify({ schema: 'pad-user.v1', progress: { noProgressLimit: 99, safetyCeiling: 9000 }, attempts: { max: 900 } }) });
  assert.deepEqual(config.progress, { noProgressLimit: 20, safetyCeiling: 1000 }); assert.equal(config.attempts.max, 100);
  assert.throws(() => load({ env, readFile: () => '{"schema":"pad-user.v1","progress":{"noProgressLimit":5,"safetyCeiling":2}}' }), /Invalid user config/);
});
// Why: a valid target does not make a symlink a permissible configuration file.
test('default synchronous reader refuses symlinks even to valid config', async t => {
  await mkdir('.scratch', { recursive: true });
  const dir = await mkdtemp(resolve('.scratch/config-link-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'regular.json'), link = join(dir, 'link.json');
  writeFileSync(file, '{"schema":"pad-user.v1"}'); symlinkSync(file, link);
  assert.equal(load({ env: { PAD_USER_CONFIG: file } }).schema, 'pad-user.v1');
  assert.throws(() => load({ env: { PAD_USER_CONFIG: link } }), /User config unavailable/);
});
// Why: parseable whitespace must not bypass the reader byte limit.
test('default reader refuses valid JSON larger than 256 KiB', async t => {
  await mkdir('.scratch', { recursive: true });
  const dir = await mkdtemp(resolve('.scratch/config-cap-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'large.json'); writeFileSync(file, '{"schema":"pad-user.v1"}'.padEnd(262145, ' '));
  assert.throws(() => load({ env: { PAD_USER_CONFIG: file } }), /User config unavailable/);
});
// Why: opening a FIFO must not wait indefinitely before the regular-file check.
test('default reader refuses FIFO without waiting for a writer', async t => {
  await mkdir('.scratch', { recursive: true });
  const dir = await mkdtemp(resolve('.scratch/config-fifo-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const fifo = join(dir, 'config'); execFileSync('mkfifo', [fifo]);
  const code = 'import {loadUserConfig} from ' + JSON.stringify(modulePath.href) + '; try { loadUserConfig({env:{PAD_USER_CONFIG:process.argv[1]}}); process.exitCode=2; } catch(e) { if(e.message!=="User config unavailable") process.exitCode=3; }';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, fifo], { timeout: 1500, encoding: 'utf8' });
  assert.notEqual(result.error?.code, 'ETIMEDOUT', 'FIFO reader blocked before fstat');
  assert.equal(result.status, 0, result.stderr);
});
