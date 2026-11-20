import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { recordApproval } from '../scripts/enforcement/approval_ledger_pi.js';
import { registerLinuxMicroVMCutoverInterface, createIsolationSwitch } from '../scripts/enforcement/linux_microvm_cutover_pi.js';

const PIN = '0b194cdfd86f23fd68c2685c2ccfc556a0e311e2973b1ff619c6c78791d65fcd';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v);
async function fixture(t, grant = true, maxUses = 5) {
  const parent = resolve('.scratch/g8-unattended-tests'); mkdirSync(parent, { recursive:true });
  const repo = mkdtempSync(join(parent,'case-')); t.after(() => rmSync(repo,{recursive:true,force:true}));
  const git = (...args) => execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','fixture'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  git('remote','add','origin','https://github.com/fixture-owner/fixture-repo.git');
  writeFileSync(join(repo,'.gitignore'),'.local/\n'); writeFileSync(join(repo,'check.mjs'),"console.log('# tests 1');\n");
  git('add','.'); git('commit','-m','fixture receipt'); const commit=git('rev-parse','HEAD');
  const archive=execFileSync('git',['-C',repo,'archive','--format=tar',commit]);
  const profile=join(repo,'.local','profile'); mkdirSync(join(profile,'config'),{recursive:true});
  const configPath=join(profile,'config','relay-authority.v1.json');
  const relayConfig={schema:'relay-authority.v1',githubOwner:'fixture-owner',denyRepositories:[],relayers:[{relayer:'fixture-relayer',channel:'fixture-channel',maxTier:1}],revokedIds:[]};
  writeFileSync(configPath,JSON.stringify(relayConfig));
  const input={kind:'standing',relayer:'fixture-relayer',channel:'fixture-channel',sourceMessageId:'synthetic-owner-message',quote:'Synthetic fixture owner permits isolated guest checks.',quotedQuestion:'Synthetic fixture question: allow bounded guest checks?',givenAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),tier:1,maxUses,scope:{repo:'fixture-repo',actions:['guest-check']}};
  const entry=grant?await recordApproval(profile,input):null;
  const checks=[{id:'inv',kind:'invariant-test',command:['node','check.mjs'],counter:'node-tap',covers:['Invariant'],timeoutSeconds:10}];
  const binding={taskId:'task',stepId:'build',epoch:0,writerId:'writer',dispatchId:'dispatch',commit,checksDigest:sha(canonical(checks))};
  const request={schema:'pad-linux-check-request.v1',runId:'task',requestId:randomUUID(),repo,repository:'fixture-repo',commit,binding,checks,checkout:{sha256:sha(archive),bytes:archive.toString('base64')}};
  const target={schema:'agentic-driver.microvm-target.v1',local:true,jobPayload:'exec /usr/bin/python3 /g8-supervisor.py',checksRuntime:{archive:'/synthetic/runtime.tar',sha256:'b'.repeat(64)}};
  const switchState=createIsolationSwitch(); let executions=0,probes=0;
  const good=()=>({schema:'pad-linux-check-result.v1',requestId:request.requestId,binding:structuredClone(binding),source:'guest',guestRun:request.requestId,checkoutSha256:request.checkout.sha256,runtimeSha256:target.checksRuntime.sha256,cancelled:false,teardown:{verified:true},containment:{verified:true,armed:true,taxonomySha256:PIN,tripped:false},results:[{id:'inv',commandSha256:sha(canonical(checks[0].command)),exitStatus:0,signal:null,timedOut:false,tests:1,output:'# tests 1\n'}]});
  const options={profile,isolationSwitch:switchState,loadChecksRequest:async()=>structuredClone(request),loadChecksTarget:()=>structuredClone(target),probeGuestChecks:async()=>{probes++;return {armed:true,taxonomySha256:PIN,requestId:request.requestId};},runGuestChecks:async()=>{executions++;return good();}};
  const tools=new Map(); registerLinuxMicroVMCutoverInterface({registerTool:tool=>tools.set(tool.name,tool),registerCommand(){}},options);
  const context={cwd:repo,mode:'headless',hasUI:false,ui:{confirm:async()=>assert.fail('unattended execution must not manufacture a TUI confirmation')}};
  const call=async()=>{const entrypoint=tools.get('agentic_linux_microvm_checks');assert.ok(entrypoint,'native guest-check entry point is required');return (await entrypoint.execute('test',{runId:'task'},undefined,undefined,context)).details;};
  return {repo,profile,entry,input,relayConfig,configPath,request,target,good,options,context,call,get executions(){return executions;},get probes(){return probes;},revoke(){relayConfig.revokedIds.push(entry.id);writeFileSync(configPath,JSON.stringify(relayConfig));}};
}

function attend(f) { f.context.mode='tui'; f.context.hasUI=true; f.options.isolationSwitch.set(true); }
// Why: a native TUI is context, not consent; a standing grant replaces every per-run prompt.
test('attended valid grant runs without confirmation',async t=>{
  const f=await fixture(t);attend(f);let confirmations=0;f.context.ui.confirm=async()=>{confirmations++;return true;};
  const result=await f.call();assert.equal(result.verdict,'pass');assert.equal(confirmations,0);assert.equal(result.authorization.ledgerId,f.entry.id);
});
// Why: invalid attended grants must fail before even authenticated readiness probes.
test('attended missing expired revoked and wrong repository grants never probe',async t=>{
  for(const mode of ['missing','expired','revoked','wrong-repo']) {
    const f=await fixture(t,!['missing','wrong-repo'].includes(mode));attend(f);let prompts=0;f.context.ui.confirm=async()=>{prompts++;return true;};
    if(mode==='expired')f.options.now=()=>new Date(Date.now()+120000);
    if(mode==='revoked')f.revoke();
    if(mode==='wrong-repo')await recordApproval(f.profile,{...f.input,scope:{repo:'other-repo',actions:['guest-check']}});
    assert.equal((await f.call()).verdict,'runner-unavailable');assert.equal(f.probes,0);assert.equal(f.executions,0);assert.equal(prompts,0);
  }
});
// Why: each effect needs a fresh revocation fence, including the second readiness probe.
test('attended revocation after admission fences the next probe',async t=>{
  const f=await fixture(t);attend(f);let probes=0;f.context.ui.confirm=async()=>true;
  f.options.probeGuestChecks=async()=>{probes++;f.revoke();return {armed:true,taxonomySha256:PIN,requestId:f.request.requestId};};
  assert.equal((await f.call()).verdict,'runner-unavailable');assert.equal(probes,1);assert.equal(f.executions,0);
});
// Why: a revoked or cancelled active guest must tear down and cannot publish late success.
test('attended effect fence rejects revocation and abort with teardown',async t=>{
  for(const reason of ['revoke','abort']) {
    const f=await fixture(t);attend(f);f.context.ui.confirm=async()=>true;const controller=new AbortController();let teardown=false;
    f.options.runGuestChecks=async(_request,_target,_signal,current)=>{try{if(reason==='revoke')f.revoke();else controller.abort();assert.equal(await current(),false);return f.good();}finally{teardown=true;}};
    const tools=new Map();registerLinuxMicroVMCutoverInterface({registerTool:tool=>tools.set(tool.name,tool),registerCommand(){}},f.options);
    const result=(await tools.get('agentic_linux_microvm_checks').execute('test',{runId:'task'},controller.signal,undefined,f.context)).details;
    assert.equal(result.verdict,'runner-unavailable');assert.equal(teardown,true);
  }
});
// Why: the same repository basename under another origin owner is not the grant's repository.
test('standing guest grant requires the configured Git origin owner',async t=>{
  const f=await fixture(t);execFileSync('git',['-C',f.repo,'remote','set-url','origin','https://github.com/other-fixture/fixture-repo.git']);
  assert.equal((await f.call()).verdict,'runner-unavailable');assert.equal(f.executions,0);assert.equal(f.probes,0);
});
// Why: UnattendedNeedsValidPreauth forbids treating a prompt, missing grant or expired scope as permission.
test('unattended checks need a real scoped unexpired standing ledger grant', async t => {
  for(const mode of ['missing','expired','wrong-action','wrong-repo','restricted-path']) {
    const f=await fixture(t,mode==='expired');
    if(mode==='expired') f.options.now=()=>new Date(Date.now()+120000);
    if(mode==='wrong-action'||mode==='wrong-repo'||mode==='restricted-path') await recordApproval(f.profile,{...f.input,scope:{repo:mode==='wrong-repo'?'other-repo':'fixture-repo',actions:[mode==='wrong-action'?'spawn':'guest-check'],...(mode==='restricted-path'?{paths:['unrelated']}: {})}});
    const result=await f.call(); assert.equal(result.parkReason,'checks-runner-unavailable');assert.notEqual(result.verdict,'pass');assert.equal(f.executions,0);
  }
});
// Why: NoGuestWithoutArmedKillswitch requires verified taxonomy and a live armed supervisor before guest execution.
test('unattended checks refuse an unarmed or taxonomy-mismatched killswitch', async t => {
  for(const delta of [{armed:false},{taxonomySha256:'c'.repeat(64)}]) {const f=await fixture(t);f.options.probeGuestChecks=async()=>({armed:true,taxonomySha256:PIN,...delta});const result=await f.call();assert.equal(result.parkReason,'checks-runner-unavailable');assert.equal(f.executions,0);}
});
// Why: KillswitchTripNeverPass makes a trip dominate late exit-zero evidence and prevents silent retry.
test('killswitch trip returns failed exit126 with bound log and is never silently retried', async t => {
  const f=await fixture(t); let calls=0; const log='synthetic containment trip\n';
  f.options.runGuestChecks=async()=>{calls++;return {...f.good(),containment:{verified:true,armed:true,taxonomySha256:PIN,tripped:true,log,logSha256:sha(log),exitStatus:126}};};
  const result=await f.call();assert.equal(result.verdict,'fail');assert.equal(result.exitStatus,126);assert.equal(result.nonRetryable,true);assert.equal(result.containment.logSha256,sha(log));
  f.request.requestId=randomUUID();const again=await f.call();assert.notEqual(again.verdict,'pass');assert.equal(calls,1);
});
// Why: RevokedPreauthBlocksNextRun requires fresh ledger/revocation checks rather than a cached approval.
test('revocation blocks the next unattended run and no cached grant survives', async t => {
  const f=await fixture(t);assert.equal((await f.call()).verdict,'pass');assert.equal(f.executions,1);f.revoke();f.request.requestId=randomUUID();
  const result=await f.call();assert.equal(result.parkReason,'checks-runner-unavailable');assert.equal(f.executions,1);
});
// Why: native unattended admission uses standing authorization without setting the interactive switch or faking UI.
test('valid standing preauthorization runs headlessly with the interactive switch untouched', async t => {
  const f=await fixture(t);const result=await f.call();assert.equal(result.verdict,'pass');assert.equal(f.executions,1);assert.equal(f.context.hasUI,false);assert.equal(f.options.isolationSwitch.get(),false);
  const uses=readFileSync(join(f.profile,'approvals','uses.v1.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(uses.length,1);assert.equal(uses[0].action,'guest-check');assert.equal(uses[0].result,'reserved');assert.ok(result.authorization);assert.equal(result.authorization.ledgerId,f.entry.id);assert.equal(result.authorization.useId,uses[0].use);
});
// Why: revocation during execution cannot turn a late success into newly accepted proof.
test('revocation before result acceptance rejects a late guest pass', async t => {const f=await fixture(t);f.options.runGuestChecks=async()=>{f.revoke();return f.good();};const result=await f.call();assert.notEqual(result.verdict,'pass');});
// Why: reserving the final allowed use must permit that run but fence every subsequent guest launch.
test('the final reserved standing use can complete but an exhausted grant blocks the next run', async t => {const f=await fixture(t,true,1);assert.equal((await f.call()).verdict,'pass');f.request.requestId=randomUUID();assert.equal((await f.call()).parkReason,'checks-runner-unavailable');assert.equal(f.executions,1);});
// Why: the guest cannot invent a passing denominator that contradicts its actual test output.
test('native checks reject a forged guest test count despite matching command and run identity', async t => {const f=await fixture(t);f.options.runGuestChecks=async()=>{const result=f.good();result.results[0].output='# tests 0\n';return result;};assert.notEqual((await f.call()).verdict,'pass');});
