import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initial, decide, transition } from '../scripts/workflow_runner_core.mjs';
const fixtureModule = await import(new URL('./fixtures/workflow-exit/build.mjs', import.meta.url)).catch(error => error);
const fixture = (...args) => {
  assert.ok(!(fixtureModule instanceof Error), 'workflow-exit fixture/module required');
  return fixtureModule.fixture(...args);
};
const path = new URL('../scripts/workflow_runner_exit.mjs', import.meta.url);
const api = existsSync(path) ? await import(path.href) : {};
const need = () => assert.equal(typeof api.buildGapList, 'function', 'G8 full exit gate is required');
const ok = async () => ({ exitStatus: 0, output: '# tests 1\n' });
const observe = (f, deps = {}) => { need(); return api.observeExitChecks(f.request, { runCheck: ok, ...deps }); };
const failed = id => ({ id, kind: id === 'inv' ? 'invariant-test' : 'lint', covers: [], exitStatus: 1, tests: null });
const passed = f => ({ verdict: 'pass', binding: { ...f.binding }, gaps: { gapSet: [] } });

// Why: completed all-failed summaries are retryable evidence, not missing evidence.
test('all-failed test runners return gaps for repair instead of parking incomplete', async t => {
  for (const [counter, output] of [['pytest', '1 failed in 0.01s'], ['cargo', 'test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'], ['node-tap', '# tests 1\n# pass 0\n# fail 1'], ['python-unittest', 'Ran 1 test in 0.01s\nFAILED (failures=1)']]) {
    const f = fixture(t);
    f.request.checks.find(c => c.id === 'inv').counter = counter;
    const result = await observe(f, {runCheck: async ({check}) => check.id === 'inv' ? {exitStatus: 1, output} : ok()});
    assert.equal(api.countTests(counter, output), 1, counter);
    assert.equal(result.verdict, 'fail', counter);
    assert.equal(result.parkReason, null, counter);
    assert.equal(result.results.find(r => r.id === 'inv').tests, 1, counter);
    assert.deepEqual(result.gaps.gapSet, ['inv'], counter);
  }
});
// Why: failed summaries count executed tests but skipped-only or unreadable logs cannot supply acceptance.
test('summary counters count mixed failures and retain missing and zero denominators', () => {
  need();
  assert.equal(api.countTests('pytest', '2 failed, 3 passed, 4 skipped in 0.01s'), 5);
  assert.equal(api.countTests('cargo', 'test result: FAILED. 3 passed; 2 failed; 4 ignored; 0 measured; 0 filtered out; finished in 0.00s'), 5);
  assert.equal(api.countTests('pytest', '4 skipped in 0.01s'), 0);
  assert.equal(api.countTests('cargo', 'test result: ok. 0 passed; 0 failed; 4 ignored; 0 measured; 0 filtered out; finished in 0.00s'), 0);
  for (const counter of ['pytest', 'cargo', 'node-tap', 'python-unittest']) assert.equal(api.countTests(counter, 'unparseable'), null);
});
// Why: a receipt is not independent evidence of exit checks.
test('verified receipt does not advance until exit checks pass', t => { need(); const f = fixture(t); assert.equal(decide(f.w, f.s).reason, 'checks-required'); });
// Why: fresh empty-gap proof is the only route past the exit gate.
test('all declared checks passing on the receipt commit with an empty gap set advances the step', t => { need(); const f = fixture(t); f.s.exit = passed(f); assert.equal(decide(f.w, f.s).move, 'advance'); });
// Why: a failure returns to ready with its gaps instead of settling done.
test('a failing lint check returns the step to the loop and retains the gap list', async t => {
  const f = fixture(t); need(); const claimed = transition(f.w, f.s, { id: 'claim', type: 'checks' }, { taskId: 'task' });
  const observation = await api.observeExitChecks({ ...claimed.result.request, runner: 'host' }, { runCheck: async ({ check }) => ({ exitStatus: check.id === 'lint' ? 1 : 0, output: '# tests 1\n' }) });
  observation.handoverPath = 'handover/fixture.json';
  const returned = transition(f.w, claimed.state, { id: 'proof', type: '_checks' }, { taskId: 'task', checksEventId: 'claim', exitObservation: () => observation });
  assert.equal(returned.result.reason, 'checks-failed-returned'); assert.equal(returned.state.phase, 'ready'); assert.deepEqual(returned.state.exit.gaps.gapSet, ['lint']); assert.equal(returned.state.pending, null); assert.equal(returned.state.intent, null);
});
// Why: changing gap sets signals progress independently of log hashes.
test('a shrinking or changed gap set resets the no-progress streak', t => { need(); const f = fixture(t); const previous = { gapSet: ['inv','lint'], staleStreak: 2, passes: 2 }; const gaps = api.buildGapList([failed('lint')], f.manifest, previous); assert.equal(gaps.staleStreak, 1); assert.equal(gaps.passes, 3); assert.deepEqual(gaps.previousGapSet, ['inv','lint']); });
// Why: repeated failure must park rather than retry indefinitely.
test('the same gap set for noProgressLimit consecutive passes parks as checks-no-progress', async t => { const f = fixture(t); f.request.previous = { gapSet: ['lint'], staleStreak: 2, passes: 2 }; const result = await observe(f, { runCheck: async ({ check }) => ({ exitStatus: check.id === 'lint' ? 1 : 0, output: '# tests 1\n' }) }); assert.equal(result.parkReason, 'checks-no-progress'); });
// Why: oscillation must still terminate at the safety ceiling.
test('hitting the safety ceiling parks even if gaps are changing', async t => { const f = fixture(t); f.request.previous = { gapSet: ['inv'], staleStreak: 1, passes: 49 }; const result = await observe(f, { runCheck: async ({ check }) => ({ exitStatus: check.id === 'lint' ? 1 : 0, output: '# tests 1\n' }) }); assert.equal(result.parkReason, 'checks-ceiling'); });
// Why: check retries do not consume delivery/spawn exhaustion.
test('a failing pass does not increment maxAttempts or settle exhausted', t => { need(); const f = fixture(t); f.s.phase = 'ready'; f.s.pending = null; f.s.intent = null; f.s.exit = { verdict: 'fail', retry: true, handoverConsumed: true, gaps: { gapSet: ['lint'] } }; assert.equal(decide(f.w, f.s).move, 'act'); const next = transition(f.w, f.s, { id: 'retry', type: 'tick' }); assert.deepEqual(next.state.attempts, [1]); });
// Why: a pass label cannot hide a remaining failed check.
test('a step never advances while the gap list is nonempty', t => { need(); const f = fixture(t); f.s.exit = passed(f); f.s.exit.gaps.gapSet = ['lint']; assert.equal(decide(f.w, f.s).reason, 'checks-required'); });
// Why: old commit evidence is not proof about the current receipt.
test('evidence from an earlier commit cannot advance a later receipt', t => { need(); const f = fixture(t); f.s.exit = passed(f); f.s.exit.binding.commit = f.w.revision; assert.equal(decide(f.w, f.s).reason, 'checks-required'); });
// Why: all task-local identity fields must fence foreign or stale proof.
test('evidence bound to another dispatch epoch or writer is rejected', async t => { const f = fixture(t); const observed = await observe(f); assert.equal(api.matchingExit(f.request, observed, {}), true); for (const key of ['taskId','stepId','epoch','writerId','dispatchId','commit','checksDigest']) { const changed = structuredClone(observed); changed.binding[key] = key === 'epoch' ? 99 : 'other'; assert.equal(api.matchingExit(f.request, changed, {}), false, key); } assert.equal(api.matchingExit(f.request, observed, { [observed.evidenceId]: true }), false); });
// Why: empty declarations must not pass vacuously.
test('no repo defaults and no design checks parks as checks-undeclared', t => { need(); const f = fixture(t); const result = api.resolveExitChecks(f.w, { invariants: [], checks: { add: [] } }, { show: () => JSON.stringify({ schema: 'pad-exit-checks.v1', fromGateRules: [], defaults: [] }) }); assert.equal(result.park, 'checks-undeclared'); });
// Why: every model invariant needs an executable test mapping.
test('an invariant without a covering invariant-test parks as invariant-untested', t => { need(); const f = fixture(t); const manifest = structuredClone(f.manifest); manifest.checks.add = []; assert.equal(api.resolveExitChecks(f.w, manifest, { show: f.show }).park, 'invariant-untested'); });
// Why: an empty TAP run cannot count as acceptance.
test('a test command that observes zero tests parks as checks-zero-tests', async t => { const f = fixture(t); const result = await observe(f, { runCheck: async () => ({ exitStatus: 0, output: '# tests 0\n' }) }); assert.equal(result.parkReason, 'checks-zero-tests'); });
// Why: a design may extend but cannot remove repository checks.
test('design checks extend repo defaults and cannot remove them', t => { need(); const f = fixture(t); assert.deepEqual(api.resolveExitChecks(f.w, f.manifest, { show: f.show }).checks.map(c => c.id).sort(), ['inv','lint']); });
// Why: defaults reuse exactly the reviewed argv rather than a new command.
test('fromGateRules pulls the exact argv from gate-rules at the revision', t => { need(); const f = fixture(t); const defaults = { ...f.defaults, fromGateRules: [{id:'reviewed',kind:'lint'}], defaults: [] }; const shown = []; const result = api.resolveExitChecks(f.w, f.manifest, { show: (rev,p) => { shown.push(rev); return p.endsWith('exit-checks.json') ? JSON.stringify(defaults) : f.show(rev,p); } }); assert.deepEqual(result.checks.find(c => c.id === 'reviewed').command, ['node','check.mjs']); assert.ok(shown.every(rev => rev === f.w.revision)); });
// Why: worker edits cannot weaken the pinned command declaration.
test('a worker commit that weakens exit-checks.json does not change what runs', t => { need(); const f = fixture(t); writeFileSync(join(f.repo,'.driver/exit-checks.json'), JSON.stringify({ ...f.defaults, defaults: [] })); f.git('add','.'); f.git('commit','-m','weaken'); const result = api.resolveExitChecks(f.w, f.manifest, { show: f.show }); assert.ok(result.checks.some(c => c.id === 'lint')); });
// Why: commands cannot mutate their acceptance target and still pass.
test('a check that modifies tracked files parks as checks-tree-changed', async t => { const f = fixture(t); const result = await observe(f, { runCheck: async () => { writeFileSync(join(f.repo,'artifact.md'),'changed'); return { exitStatus: 0, output: '# tests 1\n' }; } }); assert.equal(result.parkReason, 'checks-tree-changed'); });
// Why: only a clean exact receipt checkout can be observed.
test('a dirty tree or HEAD different from the receipt refuses checks', async t => { const f = fixture(t); writeFileSync(join(f.repo,'artifact.md'),'dirty'); let calls=0; const deps = { runCheck: async () => { calls++; return ok(); } }; assert.equal((await observe(f,deps)).parkReason, 'checks-tree-changed'); f.git('add','.'); f.git('commit','-m','different'); assert.equal((await observe(f,deps)).parkReason, 'checks-tree-changed'); assert.equal(calls,0); });
// Why: timeout is failed evidence even if the process reports zero.
test('a timed-out check is a retryable gap and never a pass', async t => { const f = fixture(t); const result = await observe(f,{ runCheck: async () => ({ exitStatus: 0, timedOut: true, output: '# tests 1\n' }) }); assert.equal(result.verdict,'fail'); assert.deepEqual(result.gaps.gapSet,['inv','lint']); });
// Why: host checks may receive only the explicit minimal environment.
test('check env carries no credential variables', async t => { const f=fixture(t); let env; await observe(f,{ runCheck: async request => { env=request.env; return ok(); } }); assert.deepEqual(Object.keys(env).sort(),['CI','HOME','LANG','PATH','TMPDIR']); assert.equal(env.CI,'1'); });
// Why: host mode must use the receipt checkout without a container.
test('host runner runs with no container on the local machine', async t => { const f=fixture(t); need(); const picked=await api.resolveCheckRunner({ checks:{runner:'host'} }); assert.equal(picked.runner,'host'); const result=await api.observeExitChecks(f.request); assert.equal(result.verdict,'pass'); assert.equal(result.runner,'host'); });
// Why: explicit macOS isolation cannot inherit tokens or writable mounts.
test('macos runner uses container with network none readonly mount and explicit env', async t => { const f=fixture(t); f.request.runner='macos'; f.request.image='reviewed-image'; let seen; const result=await observe(f,{ detect: () => ({ platform:'darwin',macos:{ok:true} }), runCheck: async request => { seen=request; return ok(); } }); assert.equal(result.verdict,'pass'); assert.equal(seen.command[0],'container'); assert.ok(seen.command.includes('--rm')); assert.ok(seen.command.includes('none')); assert.ok(seen.command.some(arg=>arg.includes('readonly'))); assert.ok(!seen.command.includes('--env-file')); });
// Why: required macOS prerequisites are independent load-bearing checks.
test('macos runner parks when CLI service or reviewed image is missing', t => { need(); const valid={command:true,status:true,images:['reviewed-image'],image:'reviewed-image',swVers:'26.1',machine:'arm64'}; assert.equal(api.detectMacosContainerRuntime(valid).ok,true); for(const delta of [{command:false},{status:false},{images:[]},{machine:'x86_64'},{swVers:'25.0'}]) assert.equal(api.detectMacosContainerRuntime({...valid,...delta}).park,'checks-runner-unavailable'); });
// Why: Docker and host are not substitutes for the requested Apple runtime.
test('macos refuses Docker Colima or host as a stand-in', async t => { need(); assert.equal((await api.resolveCheckRunner({ checks:{runner:'macos'} },{detect:()=>({platform:'darwin',macos:{ok:false},docker:{ok:true}})})).park,'checks-runner-unavailable'); });
// Why: automatic selection must never silently fall back to uncontained host execution.
test('auto parks on non-darwin even when another runtime reports healthy', async () => {
  const result = await api.resolveCheckRunner({checks:{runner:'auto'}}, {detect:()=>({platform:'linux',linux:{ok:true},macos:{ok:true}})});
  assert.equal(result.park, 'checks-runner-unavailable');
  assert.equal(result.runner, undefined);
});
// Why: an unavailable macOS container runtime must park instead of running on the host.
test('auto parks on darwin when the macos runtime is not ok', async () => {
  for (const facts of [{platform:'darwin',macos:{ok:false}}, {platform:'darwin'}]) {
    const result = await api.resolveCheckRunner({checks:{runner:'auto'}}, {detect:()=>facts});
    assert.equal(result.park, 'checks-runner-unavailable');
    assert.equal(result.runner, undefined);
  }
});
// Why: healthy automatic selection must retain its macOS image and recorded pick.
test('auto picks healthy macos and records its pick', async () => {
  assert.deepEqual(await api.resolveCheckRunner({checks:{runner:'auto',macos:{image:'reviewed-local'}}}, {detect:()=>({platform:'darwin',macos:{ok:true}})}), {runner:'macos',pickedBy:'auto',image:'reviewed-local'});
});
// Why: only an explicit host request permits host execution and requires no runtime probe.
test('explicit host remains requested host without detecting a runtime', async () => {
  assert.deepEqual(await api.resolveCheckRunner({checks:{runner:'host'}}, {detect:()=>{ throw new Error('must not probe'); }}), {runner:'host',pickedBy:'requested'});
});
// Why: unavailable explicit isolation never silently falls back.
test('requested unavailable isolated runner parks rather than falling back', async t => { need(); for(const runner of ['macos','linux']) assert.equal((await api.resolveCheckRunner({checks:{runner}},{detect:()=>({platform:'linux'})})).park,'checks-runner-unavailable'); });
// Why: a returning failure must be consumed through the existing producer.
test('return handover is written by the shared producer and blocks redispatch until consumed', t => { need(); const f=fixture(t); const gaps=api.buildGapList([failed('lint')],f.manifest,null); const path=api.writeReturnHandover({repo:f.repo,store:join(f.repo,'.local/workflow-runner/task'),commit:f.commit},gaps); assert.ok(existsSync(path)); f.s.phase='ready'; f.s.pending=null; f.s.intent=null; f.s.exit={verdict:'fail',retry:true,handoverPath:path,handoverConsumed:false}; assert.equal(decide(f.w,f.s).reason,'handover-unconsumed'); assert.equal(api.returnHandoverConsumed(f.repo,f.s.exit),false); });
// Why: a leftover effect cannot be replayed as fresh work.
test('an interrupted exclusive intent is blocked not replayed', t => { need(); const f=fixture(t); f.s.phase='ready'; f.s.pending=null; assert.equal(decide(f.w,f.s).reason,'unconfirmed-effect'); });
// Why: duplicate public claims must not execute checks again.
test('duplicate checks event replays the original claim', t => { need(); const f=fixture(t); const event={id:'claim',type:'checks'}; const once=transition(f.w,f.s,event,{taskId:'task'}); const again=transition(f.w,once.state,event,{taskId:'task'}); assert.equal(again.duplicate,true); assert.deepEqual(again.state,once.state); });
// Why: only host-issued private observations can enter through the public facade.
test('private checks events stay rejected and Pi exposes the public checks gate', t => { need(); const cli=readFileSync(new URL('../scripts/pad-runner.mjs',import.meta.url),'utf8'); const pi=readFileSync(new URL('../extensions/workflow-runner.js',import.meta.url),'utf8'); assert.ok(cli.includes("type === 'checks'")); assert.ok(pi.includes("'checks'")); assert.ok(!cli.includes("['_checks']")); });
