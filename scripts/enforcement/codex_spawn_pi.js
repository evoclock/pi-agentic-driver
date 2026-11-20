// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, realpathSync, statSync, lstatSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, isAbsolute, basename, relative, sep, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function accountConfig(configPath) {
  const configStat = lstatSync(configPath);
  if (realpathSync(configPath) !== configPath || !configStat.isFile() || configStat.uid !== process.getuid() || (configStat.mode & 0o022)) throw new Error('Codex account configuration denied');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const accounts = config.accounts;
  if (config.schema !== 'pad.codex-accounts.v1' || !accounts || Array.isArray(accounts)
      || Object.getPrototypeOf(accounts) !== Object.prototype || !Object.keys(accounts).length
      || Object.entries(accounts).some(([id, entry]) => !ACCOUNT_ID.test(id)
        || !entry || Array.isArray(entry) || Object.getPrototypeOf(entry) !== Object.prototype
        || Object.keys(entry).sort().join(',') !== 'daybreak,home,model'
        || typeof entry.home !== 'string' || typeof entry.model !== 'string' || !MODEL_ID.test(entry.model)
        || typeof entry.daybreak !== 'boolean')) throw new Error('Codex account configuration denied');
  return config;
}

// Only an explicitly supplied local config can classify a model; Pi's native
// installed-model roster remains authoritative when no account config is supplied.
export function isCodexAccountModel(model, configPath) {
  return configPath ? Object.values(accountConfig(configPath).accounts).some((entry) => entry.model === model) : false;
}


// Configuration contains *paths*, never authentication material. No fallback
// to the caller's CODEX_HOME: an absent account home is a refusal.
export function codexLaunch(account, model, configPath = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'codex-accounts.v1.json')) {
  const config = accountConfig(configPath);
  const selected = Object.hasOwn(config.accounts, account) ? config.accounts[account] : null;
  if (!selected || selected.model !== model) throw new Error('Codex account/model combination denied');
  const home = selected.home;
  if (typeof home !== 'string' || !isAbsolute(home) || home.includes('\0') || home.includes('\n') || home.includes('=') || /\s/.test(home)) throw new Error('CODEX_HOME path denied');
  const homeStat = statSync(home);
  if (realpathSync(home) !== home || !homeStat.isDirectory() || homeStat.uid !== process.getuid() || (homeStat.mode & 0o022)) throw new Error('CODEX_HOME must be an owned canonical directory');
  // Owner-configured canonical install target, not the bot's inherited PATH.
  const binaryRealPath = config.binaryRealPath;
  const binaryRealRoot = config.binaryRealRoot;
  if (binaryRealRoot !== undefined && (!cleanAbsolute(binaryRealRoot)
      || realpathSync(binaryRealRoot) !== binaryRealRoot || !statSync(binaryRealRoot).isDirectory())) {
    throw new Error('Codex binary configuration denied');
  }
  if (binaryRealPath !== undefined && (!cleanAbsolute(binaryRealPath)
      || basename(binaryRealPath) !== 'codex' || realpathSync(binaryRealPath) !== binaryRealPath
      || (binaryRealRoot && !insideReleaseRoot(binaryRealPath, binaryRealRoot)))) {
    throw new Error('Codex binary configuration denied');
  }
  const binaryLaunchPath = config.binaryLaunchPath ?? binaryRealPath;
  if (!cleanAbsolute(binaryLaunchPath) || basename(binaryLaunchPath) !== 'codex'
      || (!binaryRealRoot && (!binaryRealPath || realpathSync(binaryLaunchPath) !== binaryRealPath))
      || (binaryRealRoot && !insideReleaseRoot(realpathSync(binaryLaunchPath), binaryRealRoot))) {
    throw new Error('Codex binary configuration denied');
  }
  const argv = ['-m', model, '-c', selected.daybreak ? 'daybreak=true' : 'daybreak=false'];
  return Object.freeze({ home, binaryRealPath, binaryRealRoot, binaryLaunchPath, argv: Object.freeze(argv) });
}

const PYTHON = '/usr/bin/python3';
const HOME_READER = fileURLToPath(new URL('./codex_home_reader.py', import.meta.url));

export function hasCodexProcessReader(options = {}) {
  if (typeof options.readCodexProcess === 'function') return true;
  // An injected transport never authorizes production process observation.
  return !options.testExecutablePath && process.platform === 'darwin'
    && existsSync(PYTHON) && existsSync(HOME_READER);
}

function productionProcessFacts(pid) {
  // args= has no environment. Never return its raw output in an error.
  const args = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'args='],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 });
  const home = spawnSync(PYTHON, ['-I', '-S', HOME_READER, String(pid)],
    { encoding: 'utf8', timeout: 3000, maxBuffer: 2048, env: { PATH: '/usr/bin:/bin' } });
  if (args.status !== 0 || home.status !== 0 || !args.stdout || !home.stdout) {
    throw new Error('Codex process readback unavailable');
  }
  return { args: args.stdout.trim(), home: home.stdout };
}

// argv0 is not a trusted executable identity. Refuse an unqualified name or
// a shadowed path; require the configured canonical target and a native Mach-O
// header rather than certifying an executable shell script named codex.
function cleanAbsolute(path) {
  return typeof path === 'string' && isAbsolute(path) && path === resolve(path)
    && !path.includes('\0') && !/\s/.test(path);
}

function insideReleaseRoot(path, root) {
  if (!cleanAbsolute(path) || !cleanAbsolute(root)) return false;
  const parts = relative(root, path).split(sep);
  return parts.length === 3 && parts[0] !== '.' && parts[0] !== '..'
    && parts[1] === 'bin' && parts[2] === 'codex';
}

function codexExecutable(token, expected, launcher, root) {
  if (!cleanAbsolute(token) || basename(token) !== 'codex'
      || (token !== expected && token !== launcher)) return false;
  try {
    const target = realpathSync(token);
    if (root ? !insideReleaseRoot(target, root) : target !== expected) return false;
    const entry = statSync(token);
    if (!entry.isFile() || !(entry.mode & 0o111)) return false;
    const fd = openSync(token, 'r');
    const header = Buffer.alloc(4);
    let size;
    try { size = readSync(fd, header, 0, 4, 0); }
    finally { closeSync(fd); }
    return size === 4 && ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(header.toString('hex'));
  } catch { return false; }
}

// The production helper returns one key only; synthetic string facts are
// accepted solely through the injected test seam. Never return or log raw ps.
export function verifyCodexProcess(agent, launch, options = {}) {
  if (!Number.isSafeInteger(agent?.pid) || agent.pid <= 1) throw new Error('Codex process PID unavailable');
  if (!hasCodexProcessReader(options)) throw new Error('Codex process readback unavailable');
  const facts = typeof options.readCodexProcess === 'function'
    ? options.readCodexProcess(agent.pid) : productionProcessFacts(agent.pid);
  const legacy = typeof facts === 'string' && facts.length <= 64 * 1024 ? facts.trim().split(/\s+/) : null;
  const tokens = legacy ?? (typeof facts?.args === 'string' && facts.args.length <= 64 * 1024
    ? facts.args.trim().split(/\s+/) : []);
  const env = legacy ? tokens.filter((token) => token.startsWith('CODEX_HOME='))
    : typeof facts?.home === 'string' ? [`CODEX_HOME=${facts.home}`] : [];
  const argv = legacy ? tokens.filter((token) => !token.startsWith('CODEX_HOME=')) : tokens;
  if (argv.length !== launch.argv.length + 1 || !codexExecutable(argv[0], launch.binaryRealPath, launch.binaryLaunchPath, launch.binaryRealRoot)
      || argv.slice(1).some((token, index) => token !== launch.argv[index])
      || env.length !== 1 || env[0] !== `CODEX_HOME=${launch.home}`) {
    throw new Error('Codex process environment or launch flags mismatch');
  }
  return true;
}
