// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile, mkdtemp, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const sentinel = 'sk-test-SYNTHETIC-NEVER-REAL-keyfile';
const realSetTimeout = globalThis.setTimeout; // captured before any mock.timers use
const config = { secrets: {
  openai: { service: '<OPENAI_KEYCHAIN_SERVICE>', account: '<OPENAI_KEYCHAIN_ACCOUNT>' },
  typesafe: { service: '<TYPESAFE_KEYCHAIN_SERVICE>', account: '<TYPESAFE_KEYCHAIN_ACCOUNT>' },
} };

// Replay the existing loader on base, rather than failing because a new module cannot be imported.
async function loader() {
  const path = new URL('../scripts/credential_store.mjs', import.meta.url);
  try { await readFile(path); return (await import(path.href)).loadProviderCredential; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = await readFile(new URL('../scripts/skill_usage_eval.mjs', import.meta.url), 'utf8');
  const body = source.match(/async function credentialOptions\(provider\) \{([\s\S]*?)\n\}/)[1];
  const old = new (Object.getPrototypeOf(async function () {}).constructor)(
    'provider', 'process', 'readFile', 'join', 'homedir', body);
  return async (provider, deps) => {
    const result = await old(provider, { env: deps.env }, deps.readFile, join, () => deps.env.HOME);
    return { key: result.openaiKey ?? result.jevKey };
  };
}

function fake({ env = {}, userConfig = config, output = sentinel + '\n', code = 0,
  spawnError = false, file = sentinel + '\n', present = false, platform = 'darwin' } = {}) {
  const calls = [], reads = [], warnings = [];
  return { calls, reads, warnings, deps: {
    env: { HOME: '<OWNER_HOME>', ...env }, userConfig, platform,
    probeExecutable: async () => true,
    stderr: { write: (text) => warnings.push(text) },
    stat: async () => { if (!present) throw Object.assign(new Error(sentinel), { code: 'ENOENT' }); return { isFile: () => true }; },
    readFile: async (path) => { reads.push(path); if (file === null) throw new Error(sentinel); return file; },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        if (spawnError) child.emit('error', new Error(sentinel));
        else { child.stdout.end(output); child.stderr.end(sentinel); child.emit('close', code); }
      });
      return child;
    },
  } };
}
async function obtain(f, provider = 'openai') { return (await loader())(provider, f.deps); }
function privateText(f, error = '') {
  assert.ok(!JSON.stringify([f.warnings, String(error), f.calls]).includes(sentinel));
}

// Why: Explicit environment keys must bypass store and file access, even with broken local configuration.
test('environment API key is used and the secret store is not consulted', async () => {
  const f = fake({ env: { OPENAI_API_KEY: sentinel, OPENAI_API_KEY_FILE: '<KEY_FILE>' }, userConfig: {}, present: true });
  assert.deepEqual(await obtain(f), { key: sentinel });
  assert.equal(f.calls.length, 0); assert.deepEqual(f.reads, []);
  assert.match(f.warnings.join(''), /ignored.*no longer the default/); privateText(f);
});

// Why: The macOS default must capture the store result privately using exact argv, never a shell.
test('macOS default reads Keychain via security find-generic-password', async () => {
  const f = fake(); assert.deepEqual(await obtain(f), { key: sentinel });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, '/usr/bin/security');
  assert.deepEqual(f.calls[0].args, ['find-generic-password', '-s', '<OPENAI_KEYCHAIN_SERVICE>', '-a', '<OPENAI_KEYCHAIN_ACCOUNT>', '-w']);
  assert.deepEqual(f.calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(!f.calls[0].options.shell); assert.deepEqual(f.calls[0].options.env, {});
  assert.deepEqual(f.reads, []); privateText(f);
});

// Why: Linux uses the same configured names through libsecret, including the typesafe provider mapping.
test('Linux default reads libsecret via secret-tool lookup service account', async () => {
  const f = fake({ platform: 'linux' }); assert.deepEqual(await obtain(f, 'jev'), { key: sentinel });
  assert.equal(f.calls[0].command, '/usr/bin/secret-tool');
  assert.deepEqual(f.calls[0].args, ['lookup', 'service', '<TYPESAFE_KEYCHAIN_SERVICE>', 'account', '<TYPESAFE_KEYCHAIN_ACCOUNT>']);
  assert.deepEqual(f.reads, []); privateText(f);
});

// Why: Linux needs session-bus discovery without forwarding credentials or the full process environment.
test('Linux forwards only session-bus discovery variables to libsecret', async () => {
  const f = fake({ platform: 'linux', env: { DBUS_SESSION_BUS_ADDRESS: '<SESSION_BUS>', XDG_RUNTIME_DIR: '<RUNTIME_DIR>',
    TYPESAFE_API_KEY: sentinel, OTHER_SECRET: sentinel } });
  assert.deepEqual(await obtain(f), { key: sentinel });
  assert.deepEqual(f.calls[0].options.env, { DBUS_SESSION_BUS_ADDRESS: '<SESSION_BUS>', XDG_RUNTIME_DIR: '<RUNTIME_DIR>' });
  privateText(f);
});

// Why: Nonzero store status must discard even plausible stdout and redact tool stderr.
test('missing secret-store item fails closed without leaking the value or tool stderr', async () => {
  const f = fake({ code: 44 });
  await assert.rejects(obtain(f), (e) => { assert.match(e.message, /credential unavailable/); privateText(f, e); return true; });
  assert.deepEqual(f.reads, []);
});

// Why: A successful store lookup takes precedence over an explicit legacy file.
test('store hit wins over explicit KEY_FILE', async () => {
  const f = fake({ env: { OPENAI_API_KEY_FILE: '<KEY_FILE>' }, file: 'unused' });
  assert.deepEqual(await obtain(f), { key: sentinel }); assert.deepEqual(f.reads, []); privateText(f);
});

// Why: The clarified fallback permits only explicitly selected files after a missing item, with a variable-only warning.
test('explicit KEY_FILE is opt-in, warns, and loads the file after missing store item', async () => {
  const f = fake({ code: 44, env: { OPENAI_API_KEY_FILE: '<KEY_FILE>' } });
  assert.deepEqual(await obtain(f), { key: sentinel }); assert.deepEqual(f.reads, ['<KEY_FILE>']);
  assert.equal(f.warnings.join(''), 'warning: using OPENAI_API_KEY_FILE; prefer the OS secret store\n');
  privateText(f);
});

// Why: Missing store names must not prevent the explicitly configured file fallback or invoke a real tool.
test('store missing names plus explicit FILE loads with warning', async () => {
  const f = fake({ userConfig: {}, env: { TYPESAFE_API_KEY_FILE: '<KEY_FILE>' } });
  assert.deepEqual(await obtain(f, 'jev'), { key: sentinel }); assert.equal(f.calls.length, 0);
  assert.match(f.warnings.join(''), /using TYPESAFE_API_KEY_FILE/); privateText(f);
});

// Why: Tool startup failures are public unavailability, not raw errors, and still permit explicit fallback.
test('store tool missing plus explicit FILE loads with warning', async () => {
  const f = fake({ spawnError: true, env: { OPENAI_API_KEY_FILE: '<KEY_FILE>' } });
  assert.deepEqual(await obtain(f), { key: sentinel }); assert.equal(f.calls.length, 1);
  assert.match(f.warnings.join(''), /using OPENAI_API_KEY_FILE/); privateText(f);
});

// Why: No configured usable source must fail closed instead of discovering a home credential.
test('store missing names and no FILE fails closed', async () => {
  const f = fake({ userConfig: {} });
  await assert.rejects(obtain(f), /credential unavailable/); assert.deepEqual(f.reads, []); privateText(f);
});

// Why: File failures must never propagate file contents or paths into public errors.
test('empty or unreadable explicit FILE fails closed privately', async () => {
  for (const file of ['', ' \n', null]) {
    const f = fake({ userConfig: {}, env: { OPENAI_API_KEY_FILE: '<KEY_FILE>' }, file });
    await assert.rejects(obtain(f), (e) => { assert.match(e.message, /credential unavailable/); privateText(f, e); return true; });
    assert.deepEqual(f.reads, ['<KEY_FILE>']);
  }
});

// Why: The previous implicit home-file fallback must stay removed even when it could supply a valid key.
test('implicit home key is not loaded', async () => {
  const f = fake({ code: 1 }); await assert.rejects(obtain(f), /credential unavailable/);
  assert.deepEqual(f.reads, []); privateText(f);
});

// Why: Existing ignored home files need a migration warning without ever opening their contents.
test('implicit home key file present produces ignored-file warning and is not used', async () => {
  const f = fake({ present: true }); assert.deepEqual(await obtain(f), { key: sentinel });
  assert.deepEqual(f.reads, []); assert.match(f.warnings.join(''), /ignored.*no longer the default/); privateText(f);
});

// Why: Unsupported platforms and empty store stdout must be unavailable, not successful empty credentials.
test('unsupported platform and empty store result fail closed', async () => {
  for (const options of [{ platform: 'unsupported' }, { output: ' \n' }]) {
    const f = fake(options); await assert.rejects(obtain(f), /credential unavailable/); privateText(f);
  }
});

// Why: Exercise real CLI error reporting and every report file without network calls or access to real credentials.
test('CLI output errors warnings and out files never contain sentinel across success missing-store missing-file env-override', async () => {
  await mkdir('.scratch', { recursive: true });
  const home = await mkdtemp(resolve('.scratch/credential-cli-'));
  try {
    const file = join(home, 'explicit-key'); const user = join(home, 'user.json');
    await writeFile(file, sentinel + '\n'); await writeFile(user, JSON.stringify({ schema: 'pad-user.v1' }));
    await writeFile(join(home, '.openai_key'), sentinel); await writeFile(join(home, '.typesafe_key'), sentinel);
    for (const [mode, extra, status] of [
      ['success', { OPENAI_API_KEY_FILE: file, TYPESAFE_API_KEY_FILE: file }, 0],
      ['missing-store', {}, 1],
      ['missing-file', { OPENAI_API_KEY_FILE: join(home, 'missing'), TYPESAFE_API_KEY_FILE: join(home, 'missing') }, 1],
      ['env-override', { OPENAI_API_KEY: sentinel, TYPESAFE_API_KEY: sentinel, OPENAI_API_KEY_FILE: join(home, 'missing') }, 0],
    ]) {
      const out = join(home, mode);
      const result = spawnSync(process.execPath, [resolve('scripts/skill_usage_eval.mjs'), '--dual', '--since', '24h',
        '--sessions', join(home, 'empty-sessions'), '--out', out], {
        encoding: 'utf8', env: { HOME: home, PATH: '', PAD_USER_CONFIG: user,
          OPENAI_API_KEY: '', TYPESAFE_API_KEY: '', OPENAI_API_KEY_FILE: '', TYPESAFE_API_KEY_FILE: '', ...extra },
      });
      assert.equal(result.status, status, `${mode}: ${result.stderr}`);
      assert.ok(!result.stdout.includes(sentinel)); assert.ok(!result.stderr.includes(sentinel));
      if (mode === 'success') assert.match(result.stderr, /using TYPESAFE_API_KEY_FILE/);
      if (mode === 'missing-store') assert.match(result.stderr, /credential unavailable/);
      if (status === 0) {
        const visit = async (dir) => { for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name); if (entry.isDirectory()) await visit(path);
          else assert.ok(!(await readFile(path, 'utf8')).includes(sentinel), entry.name);
        } };
        await visit(out);
      }
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

// Why: A whitespace-only environment value is not a credential and must not bypass the store.
test('whitespace-only environment key falls through to the store', async () => {
  const f = fake({ env: { OPENAI_API_KEY: ' \n' } });
  assert.deepEqual(await obtain(f), { key: sentinel }); assert.equal(f.calls.length, 1); privateText(f);
});

function silentChild(calls, emit) {
  return (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new PassThrough();
    child.kill = () => { calls.push('kill'); };
    queueMicrotask(() => emit(child));
    return child;
  };
}

// Why: Oversized store output must be discarded entirely and the tool stopped, even if it then exits 0.
test('store output over the cap is discarded and the tool is killed', async () => {
  const calls = [];
  const spawn = silentChild(calls, (child) => {
    child.stdout.emit('data', Buffer.from(sentinel + 'x'.repeat(65536)));
    child.emit('close', 0);
  });
  const f = fake(); f.deps.spawn = spawn;
  await assert.rejects(obtain(f), /credential unavailable/); assert.deepEqual(calls, ['kill']); privateText(f);
});

// Why: A hung store tool must time out to unavailability and discard any partial stdout.
test('store timeout discards partial output and kills the tool', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const spawn = silentChild(calls, (child) => {
    child.stdout.emit('data', Buffer.from(sentinel));
    queueMicrotask(() => t.mock.timers.tick(5000));
  });
  const f = fake(); f.deps.spawn = spawn;
  // A regression that never settles must fail here rather than hang the suite.
  const hung = new Promise((_, reject) => realSetTimeout(() => reject(new Error('store lookup hung')), 2000).unref());
  await assert.rejects(Promise.race([obtain(f), hung]), /credential unavailable/); assert.deepEqual(calls, ['kill']); privateText(f);
});
