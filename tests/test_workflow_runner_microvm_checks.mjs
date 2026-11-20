import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { recordApproval } from '../scripts/enforcement/approval_ledger_pi.js';
import { registerLinuxMicroVMCutoverInterface, createIsolationSwitch } from '../scripts/enforcement/linux_microvm_cutover_pi.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v);
async function fixture(t, grant = true) {
  const parent = resolve('.scratch/g8-native-conformance'); mkdirSync(parent, { recursive: true });
  const repo = mkdtempSync(join(parent, 'case-')); t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git('init','-b','fixture'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  git('remote','add','origin','https://github.com/fixture-owner/fixture-repo.git');
  const profile=join(repo,'.local','profile');mkdirSync(join(profile,'config'),{recursive:true});
  writeFileSync(join(profile,'config','relay-authority.v1.json'),JSON.stringify({schema:'relay-authority.v1',githubOwner:'fixture-owner',denyRepositories:[],relayers:[{relayer:'fixture-relayer',channel:'fixture-channel',maxTier:1}],revokedIds:[]}));
  if(grant)await recordApproval(profile,{kind:'standing',relayer:'fixture-relayer',channel:'fixture-channel',sourceMessageId:'synthetic-owner-message',quote:'Synthetic fixture owner permits isolated guest checks.',quotedQuestion:'Synthetic fixture question: allow bounded guest checks?',givenAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),tier:1,maxUses:5,scope:{repo:'fixture-repo',actions:['guest-check']}});
  writeFileSync(join(repo,'.gitignore'),'.local/\n');
  writeFileSync(join(repo,'check.mjs'), "console.log('# tests 1');\n"); git('add','.'); git('commit','-m','fixture receipt');
  const commit = git('rev-parse','HEAD'), archive = execFileSync('git',['-C',repo,'archive','--format=tar',commit]);
  const checks = [{ id:'inv', kind:'invariant-test', command:['node','check.mjs'], counter:'node-tap', covers:['Invariant'], timeoutSeconds:10 }];
  const binding = { taskId:'task', stepId:'build', epoch:0, writerId:'writer', dispatchId:'dispatch', commit, checksDigest:sha(canonical(checks)) };
  const request = { schema:'pad-linux-check-request.v1', runId:'task', requestId:randomUUID(), repo, commit, binding, checks, checkout:{ sha256:sha(archive), bytes:archive.toString('base64') } };
  const payload = 'exec /usr/bin/python3 /g8-supervisor.py';
  const target = { schema:'agentic-driver.microvm-target.v1', local:true, jobPayload:payload, checksRuntime:{ archive:'/synthetic/runtime.tar', sha256:'b'.repeat(64) } };
  const switchState = createIsolationSwitch(); switchState.set(true);
  const controller = new AbortController(); let invoked = 0, confirmations = 0;
  const context = { cwd:repo, mode:'tui', hasUI:true, ui:{confirm:async () => { confirmations++; return true; }} };
  const good = () => ({ schema:'pad-linux-check-result.v1', requestId:request.requestId, binding:structuredClone(binding), source:'guest', guestRun:request.requestId, checkoutSha256:request.checkout.sha256, runtimeSha256:target.checksRuntime.sha256, cancelled:false, teardown:{verified:true}, containment:{verified:true,armed:true,taxonomySha256:'0b194cdfd86f23fd68c2685c2ccfc556a0e311e2973b1ff619c6c78791d65fcd',tripped:false}, results:[{id:'inv',commandSha256:sha(canonical(checks[0].command)),exitStatus:0,signal:null,timedOut:false,tests:1,output:'# tests 1\n'}] });
  const options = { profile, isolationSwitch:switchState, loadChecksRequest:async () => structuredClone(request), loadChecksTarget:() => structuredClone(target), probeGuestChecks:async () => ({armed:true,taxonomySha256:'0b194cdfd86f23fd68c2685c2ccfc556a0e311e2973b1ff619c6c78791d65fcd',requestId:request.requestId}), runGuestChecks:async () => { invoked++; return good(); } };
  const tools = new Map(); registerLinuxMicroVMCutoverInterface({registerTool:tool => tools.set(tool.name,tool),registerCommand(){}},options);
  const call = async (params = {runId:'task'}) => { const entry = tools.get('agentic_linux_microvm_checks'); assert.ok(entry, 'registered native guest-check entry point is required'); return (await entry.execute('test',params,controller.signal,undefined,context)).details; };
  return {repo,request,target,payload,options,tools,context,switchState,controller,good,call,get invoked(){return invoked;},get confirmations(){return confirmations;}};
}

// Why: NativeBoundary must use the registered switch and actual context and standing grant, never an invented approval value.
test('native checks reject disabled isolation missing TUI and missing grant', async t => {
  for (const mode of ['disabled','headless','missing']) {
    const f=await fixture(t,mode!=='missing'); if(mode==='disabled') f.switchState.set(false); if(mode==='headless') f.context.mode='headless';
    const result=await f.call(); assert.equal(result.parkReason,'checks-runner-unavailable'); assert.notEqual(result.verdict,'pass'); assert.equal(f.invoked,0); assert.equal(f.target.jobPayload,f.payload);
  }
});
// Why: readiness may open an authenticated SSH connection, so missing a scoped grant must prevent even the probe.
test('missing native grant performs no backend readiness probe', async t => {
  const f=await fixture(t,false); let probes=0;
  f.context.ui.confirm=async()=>false;
  f.options.probeGuestChecks=async()=>{probes++; return {armed:true,taxonomySha256:'0b194cdfd86f23fd68c2685c2ccfc556a0e311e2973b1ff619c6c78791d65fcd',requestId:f.request.requestId};};
  const result=await f.call();
  assert.equal(result.parkReason,'checks-runner-unavailable');
  assert.equal(probes,0); assert.equal(f.invoked,0);
});
// Why: consent must still be live after reserving a use and before the first authenticated probe.
test('attended grant expiring during admission never probes',async t=>{
  const f=await fixture(t);let reads=0,probes=0;
  f.options.now=()=>new Date(Date.now()+(++reads>1?120000:0));
  f.options.probeGuestChecks=async()=>{probes++;return {armed:true};};
  assert.equal((await f.call()).verdict,'runner-unavailable');assert.equal(probes,0);assert.equal(f.invoked,0);assert.equal(f.confirmations,0);
});
// Why: CheckoutIntegrity must reject a guest result for any other receipt tree or transfer digest.
test('native checks reject a guest checkout digest mismatch', async t => { const f=await fixture(t); f.options.runGuestChecks=async()=>({...f.good(),checkoutSha256:'c'.repeat(64)}); const result=await f.call(); assert.notEqual(result.verdict,'pass'); assert.equal(result.parkReason,'checks-incomplete'); });
// Why: ResultOnlyFromGuest forbids using a successful isolation proof or an unbound result as acceptance.
test('native checks reject host proof and foreign guest-run results', async t => {
  for(const corrupt of [r=>({...r,source:'host-proof'}),r=>({...r,guestRun:'other'}),()=>({status:'VERIFIED',ok:true})]) {const f=await fixture(t); f.options.runGuestChecks=async()=>corrupt(f.good()); const result=await f.call(); assert.notEqual(result.verdict,'pass'); assert.equal(result.parkReason,'checks-incomplete');}
});
// Why: CancellationNeverPass must dominate a late successful result and incomplete teardown.
test('native checks reject cancellation timeout and missing teardown despite exit zero', async t => {
  for(const mode of ['before','during','timeout','teardown']) {const f=await fixture(t); if(mode==='before') f.controller.abort(); f.options.runGuestChecks=async()=>{if(mode==='during') f.controller.abort(); const result=f.good(); if(mode==='timeout') result.results[0].timedOut=true; if(mode==='teardown') result.teardown.verified=false; return result;}; const result=await f.call(); assert.notEqual(result.verdict,'pass');}
});
// Why: ArgvFromFrozenChecks binds each guest command to the reviewed allowlist, not a same-named replacement.
test('native checks reject substituted argv or checks digest', async t => {for(const mode of ['argv','binding']) {const f=await fixture(t); f.options.runGuestChecks=async()=>{const result=f.good(); if(mode==='argv') result.results[0].commandSha256='d'.repeat(64); else result.binding.checksDigest='d'.repeat(64); return result;}; const result=await f.call(); assert.notEqual(result.verdict,'pass'); assert.equal(result.parkReason,'checks-incomplete');}});
// Why: UnavailableNeverPass remains mandatory when the reviewed runtime or configured supervisor is absent.
test('native checks explicitly report unavailable runtime without executing', async t => {const f=await fixture(t); f.options.loadChecksTarget=()=>({schema:'agentic-driver.microvm-target.v1',local:true}); const result=await f.call(); assert.equal(result.parkReason,'checks-runner-unavailable'); assert.notEqual(result.verdict,'pass'); assert.equal(f.invoked,0);});
// Why: a safe positive control prevents an implementation that merely rejects every request from satisfying the conformance suite.
test('native checks accept only complete bound guest results after grant admission without replacing owner payload', async t => {const f=await fixture(t); const result=await f.call(); assert.equal(result.verdict,'pass'); assert.equal(result.schema,'pad-linux-check-observation.v1'); assert.equal(f.invoked,1); assert.equal(f.confirmations,0); assert.equal(f.target.jobPayload,f.payload); assert.deepEqual(result.binding,f.request.binding);});
// Why: the existing proof tool must keep its target-only closed schema when the new checks entry point is added.
test('proof tool still rejects every parameter except optional target', async t => {const f=await fixture(t); const proof=f.tools.get('agentic_linux_microvm_cutover'); assert.equal(proof.parameters.additionalProperties,false); assert.deepEqual(Object.keys(proof.parameters.properties),['target']); for(const params of [{runId:'task'},{argv:['node','check.mjs']},{payload:'anything'}]) {const result=(await proof.execute('test',params,undefined,undefined,f.context)).details; assert.equal(result.ok,false); assert.equal(result.reason.code,'model-parameters-not-allowed');} assert.equal(f.invoked,0);});
// Why: the checks entry point must accept a frozen run reference, never arbitrary argv, payload or target override.
test('checks entry point rejects additional parameters before admission', async t => {const f=await fixture(t); for(const params of [{runId:'task',argv:['node']},{runId:'task',payload:'anything'},{runId:'task',target:'local'}]) {const result=await f.call(params); assert.notEqual(result.verdict,'pass'); assert.equal(result.parkReason,'checks-runner-unavailable');} assert.equal(f.invoked,0);});
