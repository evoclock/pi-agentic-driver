// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const defaults = { schema: 'pad-user.v1', checks: { runner: 'auto' }, secrets: {}, progress: { noProgressLimit: 3, safetyCeiling: 50 }, attempts: { max: 2 }, model: { policy: 'subscription' } };
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 1024 && !/[\u0000\r\n]/.test(v);
const integer = (v, min) => Number.isSafeInteger(v) && v >= min;
function valid(c) {
  if (!closed(c, ['schema', 'checks', 'secrets', 'progress', 'attempts', 'model']) || c.schema !== 'pad-user.v1') return false;
  if (c.checks !== undefined) {
    if (!closed(c.checks, ['runner', 'macos']) || (c.checks.runner !== undefined && !['host', 'macos', 'linux', 'auto'].includes(c.checks.runner))) return false;
    const m = c.checks.macos;
    if (m !== undefined && (!closed(m, ['image', 'cpus', 'memory']) || (m.image !== undefined && !text(m.image)) || (m.cpus !== undefined && !integer(m.cpus, 1)) || (m.memory !== undefined && !text(m.memory)))) return false;
  }
  if (c.secrets !== undefined && (!closed(c.secrets, ['openai', 'typesafe']) || Object.values(c.secrets).some(s => !closed(s, ['service', 'account']) || !text(s.service) || !text(s.account)))) return false;
  if (c.progress !== undefined && (!closed(c.progress, ['noProgressLimit', 'safetyCeiling']) || (c.progress.noProgressLimit !== undefined && !integer(c.progress.noProgressLimit, 2)) || (c.progress.safetyCeiling !== undefined && !integer(c.progress.safetyCeiling, 2)))) return false;
  if (c.attempts !== undefined && (!closed(c.attempts, ['max']) || (c.attempts.max !== undefined && !integer(c.attempts.max, 1)))) return false;
  if (c.model !== undefined && (!closed(c.model, ['policy', 'localRoute']) || (c.model.policy !== undefined && !['subscription', 'local', 'local-fallback'].includes(c.model.policy)) || (c.model.localRoute !== undefined && !text(c.model.localRoute)) || (['local', 'local-fallback'].includes(c.model.policy) && !text(c.model.localRoute)))) return false;
  return true;
}
const readRegularFile = path => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 262144) throw Error('invalid user configuration file');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
};
export function loadUserConfig({ readFile = readRegularFile, env = process.env } = {}) {
  const path = env.PAD_USER_CONFIG || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'pad', 'user.v1.json');
  let bytes;
  try { bytes = readFile(path); } catch (error) { if (error.code === 'ENOENT') return structuredClone(defaults); throw Error('User config unavailable'); }
  if (bytes === undefined || bytes === null) return structuredClone(defaults);
  let c; try { c = JSON.parse(bytes); } catch { throw Error('Invalid user config'); }
  if (!valid(c)) throw Error('Invalid user config');
  const result = { ...structuredClone(defaults), ...c, checks: { ...defaults.checks, ...c.checks }, progress: { ...defaults.progress, ...c.progress }, attempts: { ...defaults.attempts, ...c.attempts }, model: { ...defaults.model, ...c.model } };
  result.progress.noProgressLimit = Math.min(20, result.progress.noProgressLimit);
  result.progress.safetyCeiling = Math.min(1000, result.progress.safetyCeiling);
  result.attempts.max = Math.min(100, result.attempts.max);
  if (result.progress.safetyCeiling < result.progress.noProgressLimit) throw Error('Invalid user config');
  return result;
}
