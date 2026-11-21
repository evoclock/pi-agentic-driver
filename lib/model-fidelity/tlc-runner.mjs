import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Why: this is the reviewed installed-only statechart-pi adapter, not a shell command supplied by a caller.
export const ADAPTER = process.env.PAD_TLC_ADAPTER ?? '/nonexistent/pad-statechart-adapter.mjs';
export const UNCERTIFIED = 'unknown';
// Why: a raw capture must not be treated as a certified property result.
export function isCertifiedCompletion(completion) {
  return completion === 'certified';
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const limit = (value, max, label) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`Invalid ${label}`);
  return value;
};

async function identity(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || (await lstat(file)).isSymbolicLink() || !(await lstat(file)).isFile()) throw new TypeError('Expected a regular absolute input file');
  const bytes = await readFile(file);
  return { path: await realpath(file), sha256: sha(bytes), size: bytes.length };
}

export async function runTlcChecks({ checks, dependencies = [], adapter = ADAPTER, budget = {}, classify, spawn = spawnSync, now = Date.now }) {
  if (adapter !== ADAPTER || !Array.isArray(checks) || !checks.length || !Array.isArray(dependencies)) throw new TypeError('Only the installed TLC adapter and nonempty checks are supported');
  const totalMs = limit(budget.totalMs ?? 60000, 300000, 'total budget');
  const checkMs = limit(budget.checkMs ?? 30000, 300000, 'check budget');
  const outputBytes = limit(budget.outputBytes ?? 4 * 1024 * 1024, 4 * 1024 * 1024, 'output budget');
  const stateLimit = budget.stateLimit ?? null;
  if (stateLimit !== null && (!Number.isSafeInteger(stateLimit) || stateLimit < 1)) throw new TypeError('Invalid state limit');
  // Why: the port cannot enforce a state limit. Never imply that a caller's state budget was checked.
  if (stateLimit !== null) return { status: 'unsupported-state-limit', raw: [], unchecked: checks.map(c => c.name), stateLimit };
  const pinnedAdapter = spawn === spawnSync ? await identity(adapter) : null;
  const records = [];
  const started = now();
  const names = new Set();
  for (const check of checks) {
    if (!check || typeof check.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(check.name) || names.has(check.name) || typeof check.out !== 'string' || !Array.isArray(check.properties) || check.properties.some(p => typeof p !== 'string' || !p)) throw new TypeError('Invalid check');
    names.add(check.name);
  }
  const inputs = await Promise.all(checks.map(async c => ({ name: c.name, spec: await identity(c.spec), config: await identity(c.config) })));
  const pinnedDependencies = await Promise.all(dependencies.map(identity));
  for (const check of checks) {
    const remaining = totalMs - (now() - started);
    if (remaining <= 0) break;
    const timeoutMs = Math.min(remaining, checkMs);
    const args = [adapter, '--spec', check.spec, '--config', check.config, '--out', check.out, '--timeout-seconds', String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
    const execution = spawn(process.execPath, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: outputBytes });
    const output = `${execution.stdout ?? ''}\n${execution.stderr ?? ''}`;
    let adapterResult = null;
    try { adapterResult = JSON.parse(execution.stdout); } catch {}
    let checker = null;
    if (adapterResult?.command?.executable) {
      try { checker = await identity(adapterResult.command.executable); } catch {}
    }
    let checkerOutput = null;
    if (adapterResult?.evidence) {
      try { checkerOutput = await readFile(path.join(check.out, 'tlc.out'), 'utf8'); } catch {}
    }
    const raw = {
      schema: 'model-fidelity.tlc-raw.v1', name: check.name, properties: [...check.properties],
      inputs: inputs.find(input => input.name === check.name), adapter: pinnedAdapter, checker, dependencies: pinnedDependencies,
      exitCode: execution.status, signal: execution.signal ?? null, errorCode: execution.error?.code ?? null,
      timedOut: execution.error?.code === 'ETIMEDOUT', outputTruncated: execution.error?.code === 'ENOBUFS',
      outputBytes: Buffer.byteLength(output), outputSha256: sha(output), output,
      checkerOutput, adapterResult, outputDirectory: check.out, elapsedBudgetMs: Math.max(0, now() - started),
      completion: isCertifiedCompletion(UNCERTIFIED) ? 'certified' : UNCERTIFIED, unchecked: [...check.properties],
    };
    if (typeof classify === 'function') raw.classification = classify(raw);
    records.push(raw);
  }
  return { status: records.length === checks.length ? 'finished' : 'budget-exhausted', raw: records, unchecked: checks.slice(records.length).map(c => c.name), budget: { totalMs, checkMs, outputBytes, stateLimit } };
}
