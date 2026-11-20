import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { initial, decide, transition } from '../scripts/workflow_runner_core.mjs';
import { dispatchWorkflow } from '../scripts/workflow_runner_dispatch.mjs';
import { fixtureAuthority } from './workflow_runner_authority_fixture.mjs';
import { run } from '../scripts/workflow_runner_core.mjs';
const modulePath = new URL('../scripts/workflow_runner_spec.mjs', import.meta.url);
// Base has no gate module. Turn absence into an explicit feature assertion,
// never a module-loader error; head must still satisfy all behavioral oracles.
const api = existsSync(modulePath) ? await import(modulePath.href) : {};
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const required = () => assert.equal(typeof api.observeSpec, 'function', 'G7 host observation is not implemented');
const adapterFixture = name => ({ ...JSON.parse(readFileSync(new URL(`./fixtures/workflow-spec/${name}/result.json`, import.meta.url), 'utf8')),
  ...(['safe', 'unsafe'].includes(name) ? { output: readFileSync(new URL(`./fixtures/workflow-spec/${name}/tlc.out`, import.meta.url), 'utf8') } : {}) });
const sources = { schema: 'pad-skill-sources.v1', sources: [
  { id: 'package', kind: 'package', name: '@synthetic/skills', version: '1.0.0' },
  { id: 'vendored', kind: 'pad-vendored', name: 'skills' }] };
const map = { schema: 'pad-spec-derivation.v1', always: { skills: ['tdd-pi', 'no-comments-pi'], playbook: 'poteto-mode-pi' },
  rules: [{ when: { feature: 'external-effect' }, skills: ['idempotent-pi'] }], harness: { default: 'pi', allowed: ['pi', 'claude', 'codex'] } };
const resolveSkill = (source, name) => ({ name, content: `# ${source.id}/${name}\n`, version: source.version, directory: '/synthetic/skills' });
function fixture(t) {
  const root = resolve('.scratch/workflow-spec-tests'); mkdirSync(root, { recursive: true });
  const repo = mkdtempSync(join(root, 'case-')); t.after(() => rmSync(repo, { recursive: true, force: true }));
  const files = {};
  for (const name of ['SPEC.tla', 'SPEC.cfg', 'SPEC-unsafe-skip.cfg', 'SPEC.view.mjs', 'chart.mmd']) files[name] = readFileSync(new URL(`./fixtures/workflow-spec/${name}`, import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('./fixtures/workflow-spec/spec.json', import.meta.url), 'utf8'));
  const w = { schema: 'pad-workflow.v1', repo, revision: 'a'.repeat(40), maxAttempts: 1,
    steps: [{ id: 'build', artifact: 'artifact.md', sha256: sha('after'), skill: { pack: 'synthetic', version: 'v1', path: 'skill.md', sha256: sha('skill'), step: 'check' },
      procedure: { schema: 'pad-procedure.v1', checks: ['git-diff-check.v1'] }, worker: { schema: 'pad-worker.v1', role: 'builder', model: 'synthetic-route', repository: 'synthetic-repo' } }] };
  const pin = () => { files['spec.json'] = JSON.stringify(manifest); w.spec = { schema: 'pad-workflow-spec-ref.v1', manifest: 'spec.json', sha256: sha(files['spec.json']) }; };
  pin();
  const calls = [], shown = [];
  const deps = { sources, map, resolveSkill, env: { PATH: '/synthetic/bin', TLA2TOOLS_JAR: '/synthetic/checker.jar' },
    show: (revision, path) => { shown.push([revision, path]); if (!(path in files)) throw Error('missing'); return files[path]; },
    runSkill: async invocation => { calls.push(invocation); return invocation.args.includes('--check') ? { exit: 0, status: 'available-not-run' }
      : invocation.args.some(arg => arg.endsWith('SPEC-unsafe-skip.cfg')) ? adapterFixture('unsafe')
      : adapterFixture('safe'); },
    runInvariant: async () => ({ exit: 0, tests: 1 }) };
  const request = () => api.specRequest(w, { ...initial(w), taskId: 'task' });
  const observe = () => { required(); return api.observeSpec(request(), deps); };
  return { repo, files, manifest, w, pin, deps, calls, shown, request, observe };
}
// Why: no worker may receive an act intent without a design reference.
test('worker step parks before dispatch when the workflow declares no spec', t => {
  const f = fixture(t); delete f.w.spec;
  assert.deepEqual(decide(f.w, initial(f.w)), { move: 'wait', phase: 'parked', reason: 'spec-missing' });
});
// Why: declaring a reference is not proof that the checker ran.
test('worker step parks with spec-unchecked until a spec event passes', t => {
  const f = fixture(t); assert.equal(decide(f.w, initial(f.w)).reason, 'spec-unchecked');
});
// Why: hashes bind evidence to the approved bytes rather than a convenient checkout.
test('spec bytes at the frozen revision that differ from the pinned digest park', async t => {
  const f = fixture(t); f.files['SPEC.tla'] += '\\* changed\n';
  assert.equal((await f.observe()).reason, 'spec-digest-mismatch'); assert.equal(f.calls.length, 0);
});
// Why: a new worker commit must not replace the frozen model.
test('a worker commit that edits the spec cannot change what was checked', async t => {
  const f = fixture(t); writeFileSync(join(f.repo, 'SPEC.tla'), 'unapproved');
  assert.equal((await f.observe()).verdict, 'pass'); assert.ok(f.shown.every(([revision]) => revision === f.w.revision));
});
// Why: the manifest must not claim an invariant TLC never checked.
test('invariant not listed in the safe cfg parks as spec-fidelity', async t => {
  const f = fixture(t); f.files['SPEC.cfg'] = 'SPECIFICATION Spec\nCONSTANT SkipGuard = TRUE\n'; f.manifest.model.safe.sha256 = sha(f.files['SPEC.cfg']); f.pin();
  assert.equal((await f.observe()).reason, 'spec-fidelity'); assert.equal(f.calls.length, 0);
});
// Why: safe counterexamples close dispatch rather than producing a stack.
test('a safe-config counterexample parks and derives no stack', async t => {
  const f = fixture(t); f.deps.runSkill = async invocation => invocation.args.includes('--check') ? { exit: 0, status: 'available-not-run' } : { exit: 1, status: 'failed', checkerExit: 12, output: 'Invariant NoSkippedReview is violated.' };
  const result = await f.observe(); assert.equal(result.reason, 'spec-counterexample'); assert.equal(result.derived, null);
});
// Why: an unsafe control that passes does not demonstrate a useful guard.
test('an unsafe config that passes parks as guard-not-load-bearing', async t => {
  const f = fixture(t), runner = f.deps.runSkill; f.deps.runSkill = async invocation => invocation.args.some(arg => arg.endsWith('SPEC-unsafe-skip.cfg')) ? adapterFixture('toy-unsafe') : runner(invocation);
  assert.equal((await f.observe()).reason, 'spec-guard-not-load-bearing');
});
// Why: any counterexample is insufficient; the declared rule must break.
test('an unsafe config failing on a different invariant parks as guard-not-load-bearing', async t => {
  const f = fixture(t), runner = f.deps.runSkill; f.deps.runSkill = async invocation => invocation.args.some(arg => arg.endsWith('SPEC-unsafe-skip.cfg')) ? { exit: 1, status: 'failed', checkerExit: 12, output: 'Invariant OtherRule is violated.' } : runner(invocation);
  assert.equal((await f.observe()).reason, 'spec-guard-not-load-bearing');
});
// Why: interrupted checking is not a successful proof.
test('incomplete or timed-out skill run parks and never derives a stack', async t => {
  const f = fixture(t), runner = f.deps.runSkill;
  for (const incomplete of [adapterFixture('toy-timeout'), { exit: 3, status: 'checked-no-errors', checkerExit: 0 }]) {
    f.deps.runSkill = async invocation => invocation.args.includes('--check') || invocation.args.some(arg => arg.endsWith('SPEC-unsafe-skip.cfg')) ? runner(invocation) : incomplete;
    const result = await f.observe(); assert.equal(result.reason, 'spec-check-incomplete'); assert.equal(result.derived, null);
  }
});
// Why: unavailable prerequisites must park without throwing or installing.
test('missing TLA2TOOLS_JAR or Java on PATH parks as checker-unavailable without throwing', async t => {
  const f = fixture(t); for (const env of [{ PATH: '/synthetic/bin' }, { TLA2TOOLS_JAR: '/synthetic/checker.jar' }]) {
    f.deps.env = env; assert.equal((await f.observe()).reason, 'spec-checker-unavailable');
  } assert.equal(f.calls.length, 0);
});
// Why: production must use the same installed-only adapter as design-time checking.
test('observeSpec invokes run-tlc.mjs --check then --spec/--config/--out and never scripts/statechart or mise', async t => {
  const f = fixture(t); assert.equal((await f.observe()).verdict, 'pass'); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[0].args, ['--check']);
  for (const call of f.calls) { assert.match(call.adapter, /scripts\/run-tlc\.mjs$/); assert.doesNotMatch(JSON.stringify(call), /scripts\/statechart|mise/); }
  for (const call of f.calls.slice(1)) { for (const flag of ['--spec', '--config', '--out']) assert.ok(call.args.includes(flag)); assert.match(call.args[call.args.indexOf('--out') + 1], /\.scratch\//); }
  assert.notEqual(f.calls[1].args.at(-1), f.calls[2].args.at(-1));
});
// Why: prompt identity must be stable across input feature order and duplicate selections.
test('derived stack is deterministic and includes the always-on skills', t => {
  required(); const f = fixture(t), a = api.deriveStack(f.manifest, map, sources, { resolveSkill });
  f.manifest.stack.extra = ['tdd-pi']; const b = api.deriveStack(f.manifest, map, sources, { resolveSkill });
  assert.deepEqual(a.derived.skills, b.derived.skills); assert.deepEqual(a.derived.playbook, b.derived.playbook);
  assert.notEqual(a.derived.specDigest, b.derived.specDigest);
  assert.deepEqual(a.derived.skills.map(s => s.name), ['idempotent-pi', 'no-comments-pi', 'tdd-pi']);
  assert.equal(a.derivedDigest, sha(canonical(a.derived)));
  f.manifest.stack.playbook = 'feature';
  const selected = api.deriveStack(f.manifest, map, sources, { resolveSkill: (source, name, options) => options?.playbook === 'feature' ? { content: '# Feature playbook\n' } : resolveSkill(source, name) });
  assert.deepEqual(selected.derived.playbook, { name: 'feature', sha256: sha('# Feature playbook\n') });
});
// Why: source ordering and content pins prevent accidental alternate-skill selection.
test('skills resolve from the first matching registered source and are pinned by content hash', t => {
  required(); const f = fixture(t), result = api.deriveStack(f.manifest, map, sources, { resolveSkill });
  for (const skill of result.derived.skills) { assert.equal(skill.sourceId, 'package'); assert.equal(skill.contentSha256, sha(`# package/${skill.name}\n`)); }
});
// Why: PAD skills remain resolvable without a matching package skill.
test('a pad-vendored source is used when the package source does not contain the skill', t => {
  required(); const f = fixture(t), result = api.deriveStack(f.manifest, map, sources, { resolveSkill: (source, name) => source.kind === 'package' ? null : resolveSkill(source, name) });
  assert.ok(result.derived.skills.every(skill => skill.sourceId === 'vendored'));
});
// Why: required skill resolution must not silently drop stack entries.
test('an unresolved skill parks as spec-stack-unresolved', t => {
  required(); const f = fixture(t); assert.equal(api.deriveStack(f.manifest, map, sources, { resolveSkill: () => null }).park, 'spec-stack-unresolved');
});
// Why: caller extras cannot manufacture an unregistered skill.
test('unknown stack.extra skill parks as spec-stack-unknown', t => {
  required(); const f = fixture(t); f.manifest.stack.extra = ['not-registered'];
  assert.equal(api.deriveStack(f.manifest, map, sources, { resolveSkill: (source, name) => name === 'not-registered' ? null : resolveSkill(source, name) }).park, 'spec-stack-unknown');
});
// Why: chart confirmation refers to committed bytes, not a label or an adapter artifact.
test('a pinned chart whose committed sha at revision does not match the pin parks as spec-chart-unconfirmed', async t => {
  const f = fixture(t); f.manifest.chart = { path: 'chart.mmd', sha256: 'f'.repeat(64) }; f.pin();
  assert.equal((await f.observe()).reason, 'spec-chart-unconfirmed');
});
// Why: a revised chart cannot inherit an earlier confirmation.
test('a changed committed chart after a spec edit parks until a new confirmation is pinned', async t => {
  const f = fixture(t); f.manifest.chart = { path: 'chart.mmd', sha256: sha(f.files['chart.mmd']) }; f.pin();
  assert.equal((await f.observe()).verdict, 'pass'); f.files['chart.mmd'] += '  Reviewed --> Finished\n'; f.pin();
  assert.equal((await f.observe()).reason, 'spec-chart-unconfirmed'); f.manifest.chart.sha256 = sha(f.files['chart.mmd']); f.pin();
  assert.equal((await f.observe()).verdict, 'pass');
});
// Why: an explicitly declared chart cannot disappear unnoticed.
test('a manifest that declares a chart path missing at revision parks as spec-chart-missing', async t => {
  const f = fixture(t); f.manifest.chart = { path: 'missing.mmd', sha256: 'f'.repeat(64) }; f.pin();
  assert.equal((await f.observe()).reason, 'spec-chart-missing');
});
// Why: the Pi adapter emits no chart; optional charts must stay optional.
test('a clean safe adapter run is accepted without a chart when the manifest has no chart key', async t => {
  const f = fixture(t), result = await f.observe(); assert.equal(result.verdict, 'pass'); assert.equal(result.chartSha256, null); assert.equal(result.confirmedChartSha256, null);
});
// Why: both-mode invariant tests are a pre-dispatch requirement.
test('when invariantWhen is both, failing invariant tests at revision park as spec-invariants-failed', async t => {
  const f = fixture(t); f.manifest.checks = { invariantWhen: 'both', add: [{ id: 'inv', kind: 'invariant-test', covers: ['NoSkippedReview'], command: ['node', '--test', 'test.mjs'], counter: 'node-tap' }] }; f.pin();
  let revision; f.deps.runInvariant = async request => { revision = request.revision; return { exit: 1, tests: 1 }; };
  assert.equal((await f.observe()).reason, 'spec-invariants-failed'); assert.equal(revision, f.w.revision);
});
// Why: G7 must not implement an undeclared G8 completion path.
test('when invariantWhen is g8, G7 does not run invariant tests and still derives the stack after a passing TLC run', async t => {
  const f = fixture(t); f.deps.runInvariant = () => assert.fail('must remain deferred');
  assert.equal((await f.observe()).derived.harness.kind, 'pi');
});
// Why: dispatch must not accept caller-selected stack content after host checking.
test('dispatch carries the derived stack and ignores a caller-supplied stack', async t => {
  const f = fixture(t), observed = await f.observe();
  const git = (...args) => execFileSync('git', ['-C', f.repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid'); writeFileSync(join(f.repo, 'artifact.md'), 'before'); git('add', 'artifact.md'); git('commit', '-qm', 'baseline');
  const s = initial(f.w); s.spec = observed; s.phase = 'awaiting'; s.intent = { taskId: 'task', stepId: 'build', dispatchId: 'dispatch-one', epoch: s.epoch, writerId: s.writerId, base: git('rev-parse', 'HEAD'), branch: git('symbolic-ref', '--short', 'HEAD'), worker: f.w.steps[0].worker };
  const result = transition(f.w, s, { id: 'dispatch', type: 'dispatch', stack: { malicious: true } });
  assert.equal(result.result.move, 'spawn'); assert.deepEqual(result.state.intent.stack, observed.derived); assert.deepEqual(result.result.intent.stack, observed.derived);
});
// Why: an unavailable harness must never enter the guarded spawn boundary.
test('harness the driver cannot serve parks before any spawn', async t => {
  required(); const f = fixture(t); const git = (...args) => execFileSync('git', ['-C', f.repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  const skill = '# Skill\n## step: check\n'; writeFileSync(join(f.repo, 'skill.md'), skill); writeFileSync(join(f.repo, 'artifact.md'), 'before');
  for (const [path, bytes] of Object.entries(f.files)) writeFileSync(join(f.repo, path), bytes);
  f.manifest.stack.harness = 'codex'; f.pin(); writeFileSync(join(f.repo, 'spec.json'), f.files['spec.json']); git('add', '.'); git('commit', '-qm', 'baseline');
  f.w.revision = git('rev-parse', 'HEAD'); f.w.steps[0].skill.sha256 = sha(skill);
  const store = join(f.repo, '.local/workflow-runner/task'), authority = fixtureAuthority(f.repo, store);
  await run(f.w, store, { id: 'start', type: 'look' }, { authority });
  await api.specGateWorkflow(f.w, store, { id: 'spec', type: 'spec' }, { ...f.deps, authority });
  await run(f.w, store, { id: 'act', type: 'tick' }, { authority });
  let spawned = false; const driver = { schema: 'pad-worker-kind-adapter.v1', kind: 'pi', host: 'local', spawn: () => { spawned = true; }, submit() {}, delivery() {} };
  const result = await dispatchWorkflow(f.w, store, { id: 'dispatch', type: 'dispatch' }, driver, { authority, readUserConfig: () => ({ model: { policy: 'subscription' } }) });
  assert.equal(result.reason, 'harness-unavailable'); assert.equal(spawned, false);
});
// Why: repeated public gate events must return stored evidence rather than rerun host work.
test('duplicate spec event replays the original answer without rerunning the skill', async t => {
  required(); const f = fixture(t), request = f.request(), observation = await f.observe();
  const s = transition(f.w, { ...initial(f.w), taskId: 'task', phase: 'parked' }, { id: 'claim-one', type: 'spec' }, { taskId: 'task' }).state, event = { id: 'spec-one', type: '_spec' };
  const once = transition(f.w, s, event, { taskId: 'task', specEventId: 'claim-one', specObservation: () => observation });
  const twice = transition(f.w, once.state, event, { taskId: 'task', specObservation: () => assert.fail('duplicate host work') });
  assert.equal(once.state.spec.verdict, 'pass'); assert.equal(twice.duplicate, true); assert.equal(api.matchingSpec(request, observation, { [observation.evidenceId]: true }), false);
  const durable = await policyFixture(t), calls = durable.calls.length;
  const replay = await api.specGateWorkflow(durable.w, durable.store, { id: 'spec', type: 'spec' }, { ...durable.deps, authority: durable.authority });
  assert.equal(replay.reason, 'spec-verified'); assert.equal(replay.duplicate, true); assert.equal(durable.calls.length, calls);
});
// Why: untrusted callers cannot inject host observation events.
test('private _spec events from the CLI or Pi are rejected', async t => {
  required(); const f = fixture(t);
  writeFileSync(join(f.repo, 'workflow.json'), JSON.stringify(f.w)); writeFileSync(join(f.repo, 'event.json'), JSON.stringify({ id: 'forged', type: '_spec' }));
  const cli = spawnSync(process.execPath, [new URL('../scripts/pad-runner.mjs', import.meta.url).pathname, 'run', '--workflow', join(f.repo, 'workflow.json'), '--run-id', 'task', '--event', join(f.repo, 'event.json'), '--store', join(f.repo, '.local/workflow-runner')], { encoding: 'utf8', cwd: f.repo });
  assert.equal(cli.status, 2); assert.match(cli.stderr, /workflow event unavailable/);
  const { default: register } = await import('../extensions/workflow-runner.js'); const tools = new Map(); register({ registerTool: tool => tools.set(tool.name, tool) });
  await assert.rejects(tools.get('agentic_workflow_tick').execute('call', { workflow: f.w, taskId: 'task', event: { id: 'forged', type: '_spec' } }, undefined, undefined, { cwd: f.repo, isProjectTrusted: () => true }), /invalid bounded/);
});
async function policyFixture(t) {
  required(); const f = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', f.repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  const skill = '# Skill\n## step: check\n'; writeFileSync(join(f.repo, 'skill.md'), skill);
  writeFileSync(join(f.repo, 'artifact.md'), 'before');
  for (const [path, bytes] of Object.entries(f.files)) writeFileSync(join(f.repo, path), bytes);
  git('add', 'SPEC.tla', 'SPEC.cfg', 'SPEC-unsafe-skip.cfg', 'SPEC.view.mjs', 'spec.json', 'skill.md', 'artifact.md'); git('commit', '-qm', 'baseline');
  f.w.revision = git('rev-parse', 'HEAD'); f.w.steps[0].skill.sha256 = sha(skill);
  const store = join(f.repo, '.local/workflow-runner/task'), authority = fixtureAuthority(f.repo, store);
  await run(f.w, store, { id: 'start', type: 'look' }, { authority });
  await api.specGateWorkflow(f.w, store, { id: 'spec', type: 'spec' }, { ...f.deps, authority });
  await run(f.w, store, { id: 'act', type: 'tick' }, { authority });
  const spawns = [];
  const driver = { schema: 'pad-worker-kind-adapter.v1', kind: 'pi', host: 'local',
    async spawn(request) { spawns.push(request.params.model); return { ok: false, status: 'partial' }; },
    async submit() { assert.fail('unknown spawn must not submit'); }, async delivery() {} };
  return { ...f, store, authority, driver, spawns };
}
// Why: fallback may select another route only on proven unavailability before any claim or spawn.
test('local-fallback uses localRoute only after a check before spawn proves unavailability', async t => {
  const f = await policyFixture(t);
  f.driver.modelAvailability = async model => {
    assert.deepEqual(f.spawns, []);
    const { readAuthorizedStatus } = await import('../scripts/workflow_runner_core.mjs');
    assert.equal((await readAuthorizedStatus(f.w, f.store, f.authority)).intent.workerStage, undefined);
    assert.equal(model, 'synthetic-route'); return { available: false, verified: true };
  };
  await dispatchWorkflow(f.w, f.store, { id: 'dispatch', type: 'dispatch' }, f.driver, { authority: f.authority, readUserConfig: () => ({ model: { policy: 'local-fallback', localRoute: 'synthetic-local' } }) });
  assert.deepEqual(f.spawns, ['synthetic-local']);
});
// Why: neither a refusal nor a lost/partial spawn outcome grants permission to try another route.
test('local-fallback never retries after a spawn attempt or unknown effect', async t => {
  for (const mode of ['partial', 'refused', 'lost', 'unproven']) {
    const f = await policyFixture(t);
    f.driver.modelAvailability = async () => mode === 'unproven' ? { available: false, verified: false } : { available: true, verified: true };
    f.driver.spawn = async request => { f.spawns.push(request.params.model); if (mode === 'lost') throw Error('lost'); return { ok: false, status: mode }; };
    const options = { authority: f.authority, readUserConfig: () => ({ model: { policy: 'local-fallback', localRoute: 'synthetic-local' } }) };
    const first = await dispatchWorkflow(f.w, f.store, { id: 'dispatch', type: 'dispatch' }, f.driver, options);
    assert.equal(first.reason, 'effect-unknown');
    await dispatchWorkflow(f.w, f.store, { id: 'again', type: 'dispatch' }, f.driver, options);
    assert.deepEqual(f.spawns, ['synthetic-route']);
  }
});
// Why: model policy selects explicit local routing without changing subscription routing or guessing availability.
test('subscription and local policies keep their explicit routes without availability fallback', async t => {
  for (const [policy, expected] of [['subscription', 'synthetic-route'], ['local', 'synthetic-local']]) {
    const f = await policyFixture(t); f.driver.modelAvailability = async () => assert.fail('no fallback probe');
    await dispatchWorkflow(f.w, f.store, { id: 'dispatch', type: 'dispatch' }, f.driver, { authority: f.authority, readUserConfig: () => ({ model: { policy, localRoute: 'synthetic-local' } }) });
    assert.deepEqual(f.spawns, [expected]);
  }
});

// Why: G7 must preserve established nonworker act behavior without introducing a spec requirement.
test('workflows without worker steps still act without a spec', t => {
  const f = fixture(t); delete f.w.spec; delete f.w.steps[0].worker; assert.equal(decide(f.w, initial(f.w)).move, 'act');
});

// Why: interrupted checker work must not permanently prevent another gate attempt.
test('a new spec event replaces an abandoned claim and fences the old result', async t => {
  required(); const f = fixture(t), observed = await f.observe();
  const start = { ...initial(f.w), taskId: 'task' };
  const first = transition(f.w, start, { id: 'claim-one', type: 'spec' }, { taskId: 'task' });
  const second = transition(f.w, first.state, { id: 'claim-two', type: 'spec' }, { taskId: 'task' });
  assert.equal(second.result.reason, 'spec-check-claimed');
  assert.equal(second.state.specClaim.eventId, 'claim-two');
  const stale = transition(f.w, second.state, { id: 'old-observation', type: '_spec' }, { taskId: 'task', specEventId: 'claim-one', specObservation: () => observed });
  assert.equal(stale.result.reason, 'spec-observation-rejected');
  assert.equal(stale.state.specClaim.eventId, 'claim-two');
  const current = transition(f.w, stale.state, { id: 'new-observation', type: '_spec' }, { taskId: 'task', specEventId: 'claim-two', specObservation: () => observed });
  assert.equal(current.result.reason, 'spec-verified');
  assert.equal(current.state.specClaim, null);
  const again = transition(f.w, current.state, { id: 'claim-three', type: 'spec' }, { taskId: 'task' }).state;
  const replay = transition(f.w, again, { id: 'reused-proof', type: '_spec' }, { taskId: 'task', specEventId: 'claim-three', specObservation: () => observed });
  assert.equal(replay.result.reason, 'spec-observation-rejected');
  assert.equal(replay.state.specClaim, null);
});
// Why: a matched rejected observation must release its claim even after epoch changes.
test('matched rejected spec observation clears its claim and can retry', async t => {
  required(); const f = fixture(t), observed = await f.observe();
  const claimed = transition(f.w, { ...initial(f.w), taskId: 'task' }, { id: 'claim', type: 'spec' }, { taskId: 'task' }).state;
  claimed.epoch++;
  const rejected = transition(f.w, claimed, { id: 'stale', type: '_spec' }, { taskId: 'task', specEventId: 'claim', specObservation: () => observed });
  assert.equal(rejected.result.reason, 'spec-observation-rejected');
  assert.equal(rejected.state.specClaim, null);
  assert.equal(transition(f.w, rejected.state, { id: 'retry', type: 'spec' }, { taskId: 'task' }).result.reason, 'spec-check-claimed');
});
// Why: private host observations still require the current public claim identity.
test('spec event identity is mandatory and must match the live claim', async t => {
  required(); const f = fixture(t), observed = await f.observe();
  const start = { ...initial(f.w), taskId: 'task' };
  const claimed = transition(f.w, start, { id: 'claim', type: 'spec' }, { taskId: 'task' }).state;
  for (const specEventId of [undefined, '', 'other']) {
    const rejected = transition(f.w, claimed, { id: 'reject', type: '_spec' }, { taskId: 'task', specEventId, specObservation: () => observed });
    assert.equal(rejected.result.reason, 'spec-observation-rejected');
    assert.equal(rejected.state.specClaim.eventId, 'claim');
  }
  for (const specEventId of [undefined, 'claim']) assert.equal(transition(f.w, start, { id: 'unclaimed', type: '_spec' }, { taskId: 'task', specEventId, specObservation: () => observed }).result.reason, 'spec-observation-rejected');
});
// Why: every part of the host binding must fence stale or cross-task evidence.
test('matchingSpec rejects each mismatched binding field', async t => {
  required(); const f = fixture(t), observed = await f.observe(), request = f.request();
  assert.equal(api.matchingSpec(request, observed), true);
  for (const [key, value] of Object.entries({ taskId: 'other-task', epoch: 1, writerId: 'other-writer', contractDigest: 'f'.repeat(64), manifestSha256: 'f'.repeat(64) })) {
    assert.equal(api.matchingSpec(request, { ...observed, [key]: value }), false, key);
  }
});
// Why: a stack must retain its checked digest, not merely a pass label.
test('matchingSpec rejects a forged derived digest or changed stack', async t => {
  required(); const f = fixture(t), observed = await f.observe(), request = f.request();
  assert.equal(api.matchingSpec(request, observed), true);
  assert.equal(api.matchingSpec(request, { ...observed, derivedDigest: 'f'.repeat(64) }), false);
  assert.equal(api.matchingSpec(request, { ...observed, derived: { ...observed.derived, harness: { kind: 'codex' } } }), false);
});
// Why: a checked prior manifest must not authorize act for a different manifest.
test('specPassed binds act admission to the current manifest digest', async t => {
  required(); const f = fixture(t), observed = await f.observe();
  const s = { ...initial(f.w), spec: observed };
  assert.equal(decide(f.w, s).move, 'act');
  f.w.spec.sha256 = 'f'.repeat(64);
  assert.equal(decide(f.w, s).reason, 'spec-unchecked');
});
// Why: dispatch needs its own spec guard even when no act intent is present.
test('dispatch independently requires a checked spec', t => {
  required(); const f = fixture(t);
  assert.equal(transition(f.w, initial(f.w), { id: 'dispatch', type: 'dispatch' }).result.reason, 'spec-required');
});
// Why: zero and negative budgets must never reach the invariant process runner.
test('expired early invariant budgets park incomplete without executing a command', async t => {
  required(); const realNow = Date.now;
  try {
    for (const overrun of [0, 1]) {
      let clock = realNow(); Date.now = () => clock;
      const f = fixture(t), runner = f.deps.runSkill;
      f.manifest.checks = { invariantWhen: 'both', add: [{ id: 'inv', kind: 'invariant-test', covers: ['NoSkippedReview'], command: ['node', '--test'], counter: 'node-tap' }] }; f.pin();
      f.deps.runSkill = async request => { const result = await runner(request); if (request.args.some(arg => arg.endsWith('SPEC-unsafe-skip.cfg'))) clock += 300000 + overrun; return result; };
      let calls = 0; f.deps.runInvariant = async () => { calls++; return { exit: 0, tests: 1 }; };
      assert.equal((await f.observe()).reason, 'spec-check-incomplete');
      assert.equal(calls, 0);
    }
  } finally { Date.now = realNow; }
});
