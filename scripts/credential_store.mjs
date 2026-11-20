// SPDX-License-Identifier: AGPL-3.0-only
import { spawn as spawnProcess } from 'node:child_process';
import { readFile as read, stat as fileStat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { loadUserConfig } from './workflow_runner_user_config.mjs';

// Tool output is private, bounded in memory and never attached to errors or diagnostics.
function storeKey(spawn, command, args, toolEnv = {}) {
  return new Promise((resolve) => {
    let child, timer, output = '', settled = false;
    const finish = (key = '') => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(key);
    };
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: toolEnv });
      timer = setTimeout(() => { finish(); child.kill(); }, 5000);
      child.on('error', () => finish());
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        if (Buffer.byteLength(output) + chunk.length > 65536) { finish(); child.kill(); return; }
        output += chunk.toString();
      });
      child.stderr.resume();
      child.on('close', (code) => finish(code === 0 ? output.trim() : ''));
    } catch { finish(); }
  });
}

async function executableFile(path) {
  try {
    if (!isAbsolute(path) || !(await fileStat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/** Env > OS secret store > explicit legacy file (also on config failure). Never opens implicit home keys. */
export async function loadProviderCredential(provider, {
  env = process.env, spawn = spawnProcess, readFile, readConfigFile, userConfig,
  platform = process.platform, stderr = process.stderr, stat = fileStat, probeExecutable = executableFile,
} = {}) {
  if (!['openai', 'jev', 'typesafe'].includes(provider)) throw new Error('Unknown credential provider');
  const name = provider === 'openai' ? 'OPENAI' : 'TYPESAFE';
  const variable = `${name}_API_KEY_FILE`;
  // Whitespace-only values are not credentials; they must not bypass the store or file fallback.
  let key = env[`${name}_API_KEY`]?.trim() ? env[`${name}_API_KEY`] : undefined;
  const home = env.HOME || env.USERPROFILE;
  const implicit = home && join(home, `.${name.toLowerCase()}_key`);
  if (implicit && env[variable] !== implicit) {
    let present = false;
    try { present = (await stat(implicit)).isFile(); } catch { /* Existence only; never read contents. */ }
    if (present) stderr.write(`warning: implicit ${name.toLowerCase()} home key file ignored; no longer the default\n`);
  }
  if (key) return { key };
  // Credential file readers may be asynchronous; configuration has a separate synchronous boundary.
  const explicitFile = env[variable]?.trim();
  let config;
  try { config = userConfig ?? loadUserConfig({ readFile: readConfigFile, env }); }
  catch (error) {
    if (!explicitFile) throw error;
    config = {}; // A broken config cannot veto an explicitly selected fallback.
  }
  let toolFailure = '';
  const names = config.secrets?.[name === 'OPENAI' ? 'openai' : 'typesafe'];
  if (names?.service && names?.account) {
    if (platform === 'darwin') key = await storeKey(spawn, '/usr/bin/security',
      ['find-generic-password', '-s', names.service, '-a', names.account, '-w']);
    else if (platform === 'linux') {
      const toolEnv = Object.fromEntries(['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']
        .filter((name) => env[name]).map((name) => [name, env[name]]));
      const candidates = ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool',
        ...(env.HOME ? [join(env.HOME, '.nix-profile/bin/secret-tool')] : [])];
      let command;
      for (const path of candidates) {
        if (await probeExecutable(path)) { command = path; break; }
      }
      if (command) key = await storeKey(spawn, command,
        ['lookup', 'service', names.service, 'account', names.account], toolEnv);
      else toolFailure = `; secret-tool unavailable; tried: ${candidates.join(', ')}`;
    }
  }
  if (!key && env[variable]) {
    stderr.write(`warning: using ${variable}; prefer the OS secret store\n`);
    try { key = (await (readFile ?? read)(env[variable].trim(), 'utf8')).trim(); } catch { /* Public error below. */ }
  }
  if (!key) throw new Error(`${provider} credential unavailable; configure the OS secret store or an explicit API key source${toolFailure}`);
  return { key };
}

export async function credentialOptions(provider, deps) {
  const { key } = await loadProviderCredential(provider, deps);
  return provider === 'openai' ? { openaiKey: key } : { jevKey: key };
}
