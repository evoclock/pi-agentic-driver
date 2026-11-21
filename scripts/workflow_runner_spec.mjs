import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, posix } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const hex = /^[a-f0-9]{64}$/;
const operator = /^[A-Za-z][A-Za-z0-9_]*$/;
const skillId = /^[a-z][a-z0-9-]*$/;
const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const safePath = path => typeof path === 'string' && path.length > 0 && path.length <= 1024 && !/[\\\u0000\r\n:]/.test(path) && !path.startsWith('/') && !path.endsWith('/') && path === posix.normalize(path) && !path.split('/').some(part => part === '..' || part === '.');
const pin = (value, key = 'path') => closed(value, [key, 'sha256']) && safePath(value[key]) && hex.test(value.sha256 ?? '');
const park = reason => ({ park: reason });
const config = path => JSON.parse(readFileSync(new URL(`../config/${path}`, import.meta.url), 'utf8'));
export function validSpecRef(ref) {
  return closed(ref, ['schema', 'manifest', 'sha256']) && ref.schema === 'pad-workflow-spec-ref.v1' && safePath(ref.manifest) && ref.manifest.endsWith('.json') && hex.test(ref.sha256 ?? '');
}
function validCheck(c) {
  return closed(c, ['id', 'kind', 'command', 'cwd', 'timeoutSeconds', 'counter', 'covers']) && typeof c.id === 'string' && c.id.length > 0 &&
    ['lint', 'types', 'test', 'invariant-test'].includes(c.kind) && Array.isArray(c.command) && c.command.length > 0 && c.command.length <= 64 && c.command.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0')) &&
    (c.cwd === undefined || safePath(c.cwd)) && (c.timeoutSeconds === undefined || (Number.isSafeInteger(c.timeoutSeconds) && c.timeoutSeconds >= 1 && c.timeoutSeconds <= 600)) &&
    (!['test', 'invariant-test'].includes(c.kind) || ['node-tap', 'python-unittest', 'pytest', 'cargo'].includes(c.counter)) &&
    (c.covers === undefined || (Array.isArray(c.covers) && c.covers.every(id => operator.test(id)))) && (c.kind !== 'invariant-test' || c.covers?.length > 0);
}
function validManifest(m) {
  if (!closed(m, ['schema', 'model', 'chart', 'invariants', 'features', 'stack', 'checks']) || m.schema !== 'pad-design-spec.v1') return false;
  const model = m.model;
  if (!closed(model, ['module', 'sha256', 'view', 'viewSha256', 'dependencies', 'safe', 'unsafe']) || !safePath(model.module) || !hex.test(model.sha256 ?? '') || !safePath(model.view) || !hex.test(model.viewSha256 ?? '') || !pin(model.safe, 'config') || !Array.isArray(model.unsafe) || model.unsafe.length > 8 || model.unsafe.some(u => !closed(u, ['config', 'sha256', 'guard', 'mustViolate']) || !safePath(u.config) || !hex.test(u.sha256 ?? '') || !operator.test(u.guard ?? '') || !operator.test(u.mustViolate ?? '')) || (model.dependencies !== undefined && (!Array.isArray(model.dependencies) || model.dependencies.length > 64 || model.dependencies.some(d => !pin(d))))) return false;
  if (m.chart !== undefined && !pin(m.chart)) return false;
  if (!Array.isArray(m.invariants) || m.invariants.length === 0 || m.invariants.length > 16 || m.invariants.some(i => !closed(i, ['id', 'statement']) || !operator.test(i.id ?? '') || typeof i.statement !== 'string' || !i.statement.length) || new Set(m.invariants.map(i => i.id)).size !== m.invariants.length) return false;
  if (!Array.isArray(m.features) || m.features.some(f => typeof f !== 'string' || !f.length)) return false;
  if (!closed(m.stack, ['extra', 'playbook', 'harness']) || (m.stack.extra !== undefined && (!Array.isArray(m.stack.extra) || m.stack.extra.some(s => !skillId.test(s)))) || (m.stack.playbook !== undefined && !skillId.test(m.stack.playbook)) || (m.stack.harness !== undefined && !['pi', 'claude', 'codex'].includes(m.stack.harness))) return false;
  return closed(m.checks, ['invariantWhen', 'add']) && (m.checks.invariantWhen === undefined || ['g8', 'both'].includes(m.checks.invariantWhen)) && (m.checks.add === undefined || (Array.isArray(m.checks.add) && m.checks.add.length <= 32 && m.checks.add.every(validCheck) && new Set(m.checks.add.map(c => c.id)).size === m.checks.add.length));
}
export function loadDesignSpec(w, { show = (revision, path) => execFileSync('git', ['-C', w.repo, 'show', `${revision}:${path}`], { maxBuffer: 262145, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  if (!validSpecRef(w.spec)) return park(w.spec ? 'spec-fidelity' : 'spec-missing');
  const files = {}, digests = {};
  const read = entry => {
    const bytes = Buffer.from(show(w.revision, entry.path));
    if (bytes.length > 262144 || sha(bytes) !== entry.sha256) throw Error('spec-digest-mismatch');
    if (files[entry.path] !== undefined && digests[entry.path] !== entry.sha256) throw Error('spec-digest-mismatch');
    files[entry.path] = bytes.toString('utf8'); digests[entry.path] = sha(bytes); return bytes;
  };
  let bytes, manifest;
  try { bytes = read({ path: w.spec.manifest, sha256: w.spec.sha256 }); } catch { return park('spec-digest-mismatch'); }
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { return park('spec-fidelity'); }
  if (!validManifest(manifest)) return park('spec-fidelity');
  if (!manifest.model.unsafe.length) return park('spec-no-controls');
  const model = manifest.model;
  try {
    for (const entry of [{ path: model.module, sha256: model.sha256 }, { path: model.view, sha256: model.viewSha256 }, ...(model.dependencies ?? []), { path: model.safe.config, sha256: model.safe.sha256 }, ...model.unsafe.map(u => ({ path: u.config, sha256: u.sha256 }))]) read(entry);
  } catch { return park('spec-digest-mismatch'); }
  if (manifest.chart) {
    let chart; try { chart = Buffer.from(show(w.revision, manifest.chart.path)); } catch { return park('spec-chart-missing'); }
    if (chart.length > 262144 || sha(chart) !== manifest.chart.sha256) return park('spec-chart-unconfirmed');
    files[manifest.chart.path] = chart.toString('utf8'); digests[manifest.chart.path] = sha(chart);
  }
  return { manifest, files, digests };
}
const stripComments = text => text.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\\\*[^\n]*/g, '');
export function checkSpecFidelity(manifest, files) {
  if (!manifest.model.unsafe.length) return park('spec-no-controls');
  const module = stripComments(files[manifest.model.module] ?? ''), safe = stripComments(files[manifest.model.safe.config] ?? '');
  const invariants = safe.match(/\bINVARIANTS?\s+([\s\S]*?)(?=\s(?:CONSTANTS?|SPECIFICATION|INIT|NEXT|PROPERTY|PROPERTIES|INVARIANTS?|CONSTRAINTS?|ACTION_CONSTRAINTS?|ALIAS|POSTCONDITION|VIEW|SYMMETRY|CHECK_DEADLOCK)\b|$)/g)?.join(' ') ?? '';
  for (const invariant of manifest.invariants) if (!new RegExp(`^${invariant.id}\\s*==`, 'm').test(module) || !new RegExp(`\\b${invariant.id}\\b`).test(invariants)) return park('spec-fidelity');
  const constants = module.match(/\bCONSTANTS?\s+([\s\S]*?)(?=\b(?:VARIABLES?|ASSUME|THEOREM)\b|^[A-Za-z]\w*\s*==)/m)?.[1] ?? '';
  for (const unsafe of manifest.model.unsafe) {
    if (!manifest.invariants.some(i => i.id === unsafe.mustViolate) || !new RegExp(`\\b${unsafe.guard}\\b`).test(constants) ||
        !new RegExp(`\\b${unsafe.guard}\\s*=\\s*TRUE\\b`).test(safe) || !new RegExp(`\\b${unsafe.guard}\\s*=\\s*FALSE\\b`).test(stripComments(files[unsafe.config] ?? ''))) return park('spec-fidelity');
  }
  return { ok: true };
}
function defaultResolve(source, name, { playbook } = {}) {
  if (!skillId.test(name) || (playbook !== undefined && !skillId.test(playbook))) return null;
  try {
    let root, version;
    if (source.kind === 'package') {
      const require = createRequire(import.meta.url);
      const packageFile = require.resolve(`${source.name}/package.json`); root = dirname(packageFile);
      version = JSON.parse(readFileSync(packageFile, 'utf8')).version;
      if (version !== source.version) return null;
      root = join(root, 'skills');
    } else if (source.kind === 'pad-vendored' && safePath(source.name)) root = resolve(dirname(fileURLToPath(import.meta.url)), '..', source.name);
    else return null;
    const directory = realpathSync(join(root, name));
    if (relative(realpathSync(root), directory).startsWith('..')) return null;
    const file = realpathSync(playbook ? join(directory, 'playbooks', `${playbook}.md`) : join(directory, 'SKILL.md'));
    if (relative(realpathSync(root), file).startsWith('..')) return null;
    const content = readFileSync(file);
    return { name, directory, content, version, pin: source.kind === 'pad-vendored' ? sha(content) : undefined };
  } catch { return null; }
}
export function resolveSkillSources(sources, { resolveSkill = defaultResolve } = {}) {
  if (!closed(sources, ['schema', 'sources']) || sources.schema !== 'pad-skill-sources.v1' || !Array.isArray(sources.sources) || sources.sources.length === 0 || sources.sources.length > 32 || sources.sources.some(s => !closed(s, ['id', 'kind', 'name', 'version', 'pin']) || !skillId.test(s.id ?? '') || !['package', 'pad-vendored'].includes(s.kind) || typeof s.name !== 'string' || (s.kind === 'package' && typeof s.version !== 'string')) || new Set(sources.sources.map(s => s.id)).size !== sources.sources.length) return park('spec-stack-unresolved');
  return { resolve(name, options = {}) {
    for (const source of sources.sources) {
      let found; try { found = resolveSkill(source, name, options); } catch { found = null; }
      if (!found) continue;
      const bytes = found.content;
      if (bytes === undefined) return null;
      return { ...found, name, sourceId: source.id, kind: source.kind, ...(source.version ? { version: source.version } : { pin: found.pin ?? sha(bytes) }), contentSha256: sha(bytes) };
    }
    return null;
  } };
}
export function deriveStack(manifest, map, sources, { resolveSkill = defaultResolve } = {}) {
  const catalog = resolveSkillSources(sources, { resolveSkill });
  if (catalog.park || map?.schema !== 'pad-spec-derivation.v1' || !Array.isArray(map.always?.skills) || !Array.isArray(map.rules)) return park('spec-stack-unresolved');
  const names = [...map.always.skills];
  for (const rule of map.rules) if ((rule.when.feature && manifest.features.includes(rule.when.feature)) || (rule.when.statechart === 'has-parallel-regions' && manifest.features.includes('has-parallel-regions'))) names.push(...rule.skills);
  const extras = manifest.stack.extra ?? [];
  const resolved = [];
  for (const name of [...new Set([...names, ...extras])].sort()) {
    const skill = catalog.resolve(name);
    if (!skill) return park(extras.includes(name) && !names.includes(name) ? 'spec-stack-unknown' : 'spec-stack-unresolved');
    resolved.push({ name, sourceId: skill.sourceId, kind: skill.kind, ...(skill.version ? { version: skill.version } : { pin: skill.pin }), contentSha256: skill.contentSha256 });
  }
  const playbookName = manifest.stack.playbook ?? map.always.playbook;
  const playbook = catalog.resolve(map.always.playbook, manifest.stack.playbook ? { playbook: manifest.stack.playbook } : {});
  if (!playbook) return park('spec-stack-unresolved');
  const harness = manifest.stack.harness ?? map.harness.default;
  if (!map.harness.allowed.includes(harness)) return park('spec-stack-unresolved');
  const derived = { schema: 'pad-derived-stack.v1', skills: resolved, playbook: { name: playbookName, sha256: playbook.contentSha256 }, harness: { kind: harness }, specDigest: sha(canonical(manifest)) };
  return { derived, derivedDigest: sha(canonical(derived)) };
}
export function specRequest(w, s) {
  if (!validSpecRef(w.spec) || !w.steps.some(step => step.worker) || s.intent || ['cancelled', 'held', 'done', 'exhausted'].includes(s.phase) || !s.taskId) return null;
  return { repo: w.repo, revision: w.revision, spec: w.spec, binding: { taskId: s.taskId, epoch: s.epoch, writerId: s.writerId, contractDigest: s.contractDigest, manifestSha256: w.spec.sha256 } };
}
function runSkillProcess({ adapter, args, repo, env, timeoutMs }) {
  const result = spawnSync(process.execPath, [adapter, ...args], { cwd: repo, env: { PATH: env.PATH, TLA2TOOLS_JAR: env.TLA2TOOLS_JAR, LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1048576, shell: false });
  let parsed, output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (args.includes('--out')) {
    const out = args[args.indexOf('--out') + 1];
    try { parsed = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')); output = readFileSync(join(out, 'tlc.out'), 'utf8'); } catch { return { exit: result.status, status: 'blocked', output }; }
  } else { try { parsed = JSON.parse(result.stdout); } catch { parsed = null; } }
  return { exit: result.error || result.signal ? 3 : result.status, status: parsed?.status, checkerExit: parsed?.checkerExit, output, timedOut: result.error?.code === 'ETIMEDOUT' };
}
function countTests(counter, text) {
  const pattern = { 'node-tap': /# tests (\d+)/g, 'python-unittest': /Ran (\d+) tests?/g, pytest: /(\d+) passed/g, cargo: /test result: ok\. (\d+) passed/g }[counter];
  return pattern ? [...text.matchAll(pattern)].reduce((sum, m) => sum + Number(m[1]), 0) : 0;
}
function runInvariantProcess({ repo, revision, check, directory, timeoutMs }) {
  const checkout = join(directory, 'invariant-checkout');
  try {
    try { mkdirSync(checkout); const archive = execFileSync('git', ['-C', repo, 'archive', revision], { maxBuffer: 64 * 1024 * 1024, timeout: Math.min(30000, timeoutMs) }); execFileSync('tar', ['-x', '-C', checkout], { input: archive, timeout: Math.min(30000, timeoutMs) }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const cwd = realpathSync(join(checkout, check.cwd ?? '.'));
    if (relative(realpathSync(checkout), cwd).startsWith('..')) return { exit: 1, tests: 0 };
    const result = spawnSync(check.command[0], check.command.slice(1), { cwd, env: { PATH: process.env.PATH, CI: '1', LANG: 'C.UTF-8', HOME: directory, TMPDIR: directory }, timeout: Math.min(timeoutMs, (check.timeoutSeconds ?? 120) * 1000), maxBuffer: 1048576, encoding: 'utf8', shell: false });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return { exit: result.error || result.signal ? null : result.status, tests: countTests(check.counter, output), outputSha256: sha(output) };
  } catch { return { exit: null, tests: 0 }; }
}
export async function observeSpec(request, deps = {}) {
  const evidenceId = `spec-${randomUUID()}`, deadline = Date.now() + 300000;
  const base = { ...request?.binding, evidenceId, manifestSha256: request?.binding?.manifestSha256, derived: null, derivedDigest: null, chartSha256: null, confirmedChartSha256: null };
  const failed = reason => ({ ...base, verdict: ({ 'spec-counterexample': 'counterexample', 'spec-guard-not-load-bearing': 'guard-not-load-bearing', 'spec-checker-unavailable': 'unavailable', 'spec-digest-mismatch': 'mismatch', 'spec-fidelity': 'fidelity', 'spec-chart-missing': 'chart-missing', 'spec-chart-unconfirmed': 'chart-unconfirmed', 'spec-invariants-failed': 'invariants-failed' })[reason] ?? 'incomplete', reason });
  if (!request) return failed('spec-missing');
  const show = deps.show ?? ((revision, path) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('deadline');
    return execFileSync('git', ['-C', request.repo, 'show', `${revision}:${path}`], { maxBuffer: 262145, timeout: Math.min(10000, remaining), stdio: ['ignore', 'pipe', 'pipe'] });
  });
  const loaded = loadDesignSpec(request, { show });
  if (Date.now() >= deadline) return failed('spec-check-incomplete');
  if (loaded.park) return failed(loaded.park);
  const { manifest, files } = loaded, fidelity = checkSpecFidelity(manifest, files);
  if (fidelity.park) return failed(fidelity.park);
  const env = deps.env ?? process.env;
  if (!env.TLA2TOOLS_JAR || !env.PATH) return failed('spec-checker-unavailable');
  const sources = deps.sources ?? config('skill-sources.v1.json'), map = deps.map ?? config('workflow-spec-derivation.v1.json');
  const catalog = resolveSkillSources(sources, deps), checker = catalog.park ? null : catalog.resolve('statechart-pi');
  if (!checker?.directory) return failed('spec-checker-unavailable');
  const runner = deps.runSkill ?? runSkillProcess;
  let directory;
  try {
    const scratch = join(realpathSync(request.repo), '.scratch'); mkdirSync(scratch, { recursive: true });
    if (realpathSync(scratch) !== scratch) return failed('spec-check-incomplete');
    const parent = join(scratch, 'workflow-runner', 'spec'); mkdirSync(parent, { recursive: true });
    if (!realpathSync(parent).startsWith(`${scratch}/`)) return failed('spec-check-incomplete');
    directory = join(parent, evidenceId); mkdirSync(directory);
    for (const [path, bytes] of Object.entries(files)) { const target = join(directory, 'files', path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: 'wx' }); }
  } catch { return failed('spec-check-incomplete'); }
  const invoke = async args => {
    const timeoutMs = Math.min(120000, deadline - Date.now());
    if (timeoutMs <= 0) return { exit: 3, status: 'blocked' };
    try { return await runner({ adapter: join(checker.directory, 'scripts', 'run-tlc.mjs'), args, repo: request.repo, env: { PATH: env.PATH, TLA2TOOLS_JAR: env.TLA2TOOLS_JAR }, timeoutMs }); }
    catch { return { exit: 3, status: 'blocked' }; }
  };
  const availability = await invoke(['--check']);
  if (availability.exit !== 0 || availability.status !== 'available-not-run') return failed('spec-checker-unavailable');
  let index = 0;
  const check = async cfg => invoke(['--spec', join(directory, 'files', manifest.model.module), '--config', join(directory, 'files', cfg), '--out', join(directory, `output-${index++}`)]);
  const safe = await check(manifest.model.safe.config);
  if (safe.exit === 1 && safe.status === 'failed') return failed('spec-counterexample');
  if (!(safe.exit === 0 && safe.status === 'checked-no-errors' && safe.checkerExit === 0)) return failed('spec-check-incomplete');
  for (const control of manifest.model.unsafe) {
    const observed = await check(control.config);
    if (observed.exit === 3 || observed.timedOut || !['failed', 'checked-no-errors'].includes(observed.status)) return failed('spec-check-incomplete');
    const broke = [...(observed.output ?? '').matchAll(/\bInvariant ([A-Za-z][A-Za-z0-9_]*) is violated\b/g)].map(m => m[1]);
    const u = { ...observed, broke, mustViolate: control.mustViolate };
    if (!(u.exit === 1 && u.broke.includes(u.mustViolate)) || u.status !== 'failed' || u.checkerExit !== 12) return failed('spec-guard-not-load-bearing');
  }
  const invariantWhen = manifest.checks.invariantWhen ?? 'g8';
  if (invariantWhen === 'both') {
    const checks = (manifest.checks.add ?? []).filter(check => check.kind === 'invariant-test');
    if (manifest.invariants.some(invariant => !checks.some(check => check.covers.includes(invariant.id)))) return failed('spec-invariants-failed');
    for (const check of checks) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return failed('spec-check-incomplete');
      let observed; try { observed = await (deps.runInvariant ?? runInvariantProcess)({ repo: request.repo, revision: request.revision, check, directory, timeoutMs: Math.min(120000, remaining) }); } catch { observed = null; }
      if (deadline < Date.now() || observed?.exit !== 0 || !(observed.tests >= 1)) return failed('spec-invariants-failed');
    }
  }
  const derived = deriveStack(manifest, map, sources, deps);
  if (derived.park) return failed(derived.park);
  const chartSha256 = manifest.chart?.sha256 ?? null;
  return { ...base, ...derived, verdict: 'pass', reason: null, chartSha256, confirmedChartSha256: chartSha256 };
}
export function matchingSpec(request, observed, consumed = {}) {
  if (!request || !observed || !/^spec-[a-f0-9-]{36}$/.test(observed.evidenceId ?? '') || consumed[observed.evidenceId] || !Object.entries(request.binding).every(([key, value]) => observed[key] === value)) return false;
  if (observed.verdict !== 'pass') return typeof observed.reason === 'string' && observed.reason.startsWith('spec-');
  return observed.reason === null && observed.derived?.schema === 'pad-derived-stack.v1' && observed.derivedDigest === sha(canonical(observed.derived)) && observed.chartSha256 === observed.confirmedChartSha256;
}
export async function specGateWorkflow(w, store, event, deps = {}) {
  if (event?.type !== 'spec') throw Error('invalid spec event');
  const { run, readAuthorizedStatus } = await import('./workflow_runner_core.mjs');
  const admitted = await run(w, store, event, { authority: deps.authority });
  if (admitted.duplicate) {
    const state = await readAuthorizedStatus(w, store, deps.authority);
    if (state.move === 'wait' || ['cancelled', 'held'].includes(state.phase)) return admitted;
    return state.specResults?.[event.id] ? { ...state.specResults[event.id], duplicate: true } : admitted;
  }
  if (admitted.reason !== 'spec-check-claimed' || !admitted.request) return admitted;
  const observed = await observeSpec(admitted.request, deps);
  return run(w, store, { id: `spec-${randomUUID()}`, type: '_spec' }, { authority: deps.authority, specEventId: event.id, specObservation: () => observed });
}
