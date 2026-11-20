import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { run,fixtureAuthority } from './workflow_runner_authority_fixture.mjs';
const path=new URL('../scripts/enforcement/linux_microvm_checks_runtime.js',import.meta.url);
const api=existsSync(path)?await import(path.href):{};
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v && !Array.isArray(v) && typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
async function fixture(t,maxAttempts=2,procedure=false) {
  assert.equal(typeof api.loadOwnedLinuxCheckRequest,'function','authenticated native request loader required');
  const parent=resolve('.scratch/g8-native-request/tests'); mkdirSync(parent,{recursive:true}); const repo=mkdtempSync(join(parent,'case-')); t.after(()=>rmSync(repo,{recursive:true,force:true}));
  const git=(...a)=>execFileSync('git',['-C',repo,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','fixture');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(repo,'.gitignore'),'.local/\n.scratch/\n');writeFileSync(join(repo,'skill.md'),'## Step: check\n');writeFileSync(join(repo,'check.mjs'),"console.log('# tests 1');\n");
  const manifest=JSON.parse(readFileSync(new URL('./fixtures/workflow-spec/spec.json',import.meta.url)));
  for(const name of ['SPEC.tla','SPEC.cfg','SPEC-unsafe-skip.cfg','SPEC.view.mjs','chart.mmd']) writeFileSync(join(repo,name),readFileSync(new URL('./fixtures/workflow-spec/'+name,import.meta.url)));
  manifest.checks={invariantWhen:'g8',add:[{id:'inv',kind:'invariant-test',covers:[manifest.invariants[0].id],command:['node','check.mjs'],counter:'node-tap'}]};
  writeFileSync(join(repo,'spec.json'),JSON.stringify(manifest));mkdirSync(join(repo,'.driver'));writeFileSync(join(repo,'.driver/exit-checks.json'),JSON.stringify({schema:'pad-exit-checks.v1',fromGateRules:[],defaults:[{id:'lint',kind:'lint',command:['node','check.mjs']}]}));
  git('add','.');git('commit','-m','declarations');const revision=git('rev-parse','HEAD');
  const w={schema:'pad-workflow.v1',repo,revision,maxAttempts,spec:{schema:'pad-workflow-spec-ref.v1',manifest:'spec.json',sha256:sha(JSON.stringify(manifest))},steps:[{id:'build',artifact:'artifact.md',sha256:sha('after'),...(procedure?{procedure:{schema:'pad-procedure.v1',checks:['git-diff-check.v1']}}:{}),skill:{pack:'synthetic',version:'v1',path:'skill.md',sha256:sha('## Step: check\n'),step:'check'},worker:{schema:'pad-worker.v1',role:'builder',model:'synthetic-route',repository:'synthetic-repo'}}]};
  const store=join(repo,'.local/workflow-runner/task'),authority=fixtureAuthority(repo,store),ctx={cwd:repo,isProjectTrusted:()=>true};
  const claim=await run(w,store,{id:'spec',type:'spec'},{authority});
  const derived={schema:'pad-derived-stack.v1',skills:[],playbook:{name:'synthetic',sha256:sha('playbook')},harness:{kind:'pi'},specDigest:w.spec.sha256};
  await run(w,store,{id:'spec-proof',type:'_spec'},{authority,specEventId:'spec',specObservation:()=>({...claim.request.binding,evidenceId:'spec-'+randomUUID(),manifestSha256:w.spec.sha256,verdict:'pass',reason:null,derived,derivedDigest:sha(canonical(derived)),chartSha256:null,confirmedChartSha256:null})});
  const tick=await run(w,store,{id:'tick',type:'tick'},{authority}); assert.equal(tick.move,'act');
  writeFileSync(join(repo,'artifact.md'),'after');git('add','.');git('commit','-m','receipt');const commit=git('rev-parse','HEAD'),i=tick.intent;
  const receipt={stepId:'build',dispatchId:i.dispatchId,epoch:i.epoch,dispatchEpoch:i.epoch,dispatchWriter:i.writerId,writerId:i.writerId,actor:i.actor,branch:i.branch,stepBaseHead:i.base,revision,skillRef:'synthetic/v1/check',commit,check:'git-object-content'};
  assert.equal((await run(w,store,{id:'receipt',type:'receipt',receipt},{authority})).reason,'verified-receipt');
  const deps={authorityForRepository:()=>authority};
  const receiptFor=(i,commit,bytes)=>({...receipt,commit,dispatchId:i.dispatchId,epoch:i.epoch,dispatchEpoch:i.epoch,dispatchWriter:i.writerId,writerId:i.writerId,actor:i.actor,branch:i.branch,stepBaseHead:i.base,outputs:[{path:'artifact.md',sha256:sha(bytes)}]});
  return {repo,w,store,ctx,deps,authority,git,receiptFor};
}
// Why: native input is reconstructed from a real authenticated journal and the live private claim.
test('native runId resolves frozen checks and receipt bytes from the current signed claim',async t=>{
  const f=await fixture(t); assert.equal((await run(f.w,f.store,{id:'checks',type:'checks'},{authority:f.authority})).reason,'checks-claimed');
  const a=await api.loadOwnedLinuxCheckRequest(f.ctx,'task',f.deps),b=await api.loadOwnedLinuxCheckRequest(f.ctx,'task',f.deps);
  assert.deepEqual(a,b);assert.equal(a.binding.commit,a.commit);assert.equal(a.binding.taskId,'task');assert.equal(sha(Buffer.from(a.checkout.bytes,'base64')),a.checkout.sha256);assert.equal(a.outputs[0].sha256,sha('after'));
});
// Why: a receipt or editable state projection alone cannot authorize a native check request.
test('missing claim, forged projection and owner cancellation cannot load a native request',async t=>{
  const f=await fixture(t);writeFileSync(join(f.store,'state.json'),JSON.stringify({exitClaim:{eventId:'fake'}}));
  await assert.rejects(()=>api.loadOwnedLinuxCheckRequest(f.ctx,'task',f.deps));
  await run(f.w,f.store,{id:'checks',type:'checks'},{authority:f.authority});await run(f.w,f.store,{id:'cancel',type:'cancel'},{authority:f.authority});
  await assert.rejects(()=>api.loadOwnedLinuxCheckRequest(f.ctx,'task',f.deps));
});
// Why: Linux checks cross the guarded native seam, never the host executor or proof tool.
test('workflow Linux checks use the native boundary and bind its guest results',async t=>{
  const f=await fixture(t),exit=await import('../scripts/workflow_runner_exit.mjs');
  const config=join(f.repo,'.local/user.json');writeFileSync(config,JSON.stringify({schema:'pad-user.v1',checks:{runner:'linux'}}));const old=process.env.PAD_USER_CONFIG;process.env.PAD_USER_CONFIG=config;t.after(()=>{if(old===undefined)delete process.env.PAD_USER_CONFIG;else process.env.PAD_USER_CONFIG=old;});
  let native=0,host=0;const result=await exit.exitGateWorkflow(f.w,f.store,{id:'native-checks',type:'checks'},{authority:f.authority,runCheck:()=>{host++;throw Error('host forbidden');},runLinuxChecks:async()=>{native++;const req=await api.loadOwnedLinuxCheckRequest(f.ctx,'task',f.deps);return {schema:'pad-linux-check-observation.v1',binding:req.binding,verdict:'pass',results:req.checks.map(c=>({id:c.id,exitStatus:0,output:'# tests 1\n',tests:c.counter?1:null}))};}});
  assert.equal(native,1);assert.equal(host,0);assert.equal(result.reason,'checks-verified');assert.equal((await run(f.w,f.store,{id:'advance',type:'tick'},{authority:f.authority})).move,'advance');
});
// Why: a missing backend stays unavailable, with no implicit host fallback or positive evidence.
test('workflow Linux readiness unavailable parks without executing checks on the host',async t=>{
  const f=await fixture(t),exit=await import('../scripts/workflow_runner_exit.mjs');const config=join(f.repo,'.local/user.json');writeFileSync(config,JSON.stringify({schema:'pad-user.v1',checks:{runner:'linux'}}));const old=process.env.PAD_USER_CONFIG;process.env.PAD_USER_CONFIG=config;t.after(()=>{if(old===undefined)delete process.env.PAD_USER_CONFIG;else process.env.PAD_USER_CONFIG=old;});
  let host=0;const r=await exit.exitGateWorkflow(f.w,f.store,{id:'unavailable',type:'checks'},{authority:f.authority,runCheck:()=>{host++;throw Error('host forbidden');},runLinuxChecks:async()=>({verdict:'runner-unavailable',parkReason:'checks-runner-unavailable'})});assert.equal(r.reason,'checks-runner-unavailable');assert.equal(host,0);
});
// Why: Linux checks cross the guarded native seam, never the host executor or proof tool.
test('workflow Linux auto checks use the native boundary and bind its guest results',async t=>{
  const f=await fixture(t),exit=await import('../scripts/workflow_runner_exit.mjs');
  const config=join(f.repo,'.local/user.json');writeFileSync(config,JSON.stringify({schema:'pad-user.v1',checks:{runner:'auto'}}));const old=process.env.PAD_USER_CONFIG;process.env.PAD_USER_CONFIG=config;t.after(()=>{if(old===undefined)delete process.env.PAD_USER_CONFIG;else process.env.PAD_USER_CONFIG=old;});
  let native=0,host=0;const result=await exit.exitGateWorkflow(f.w,f.store,{id:'native-checks',type:'checks'},{platform:'linux',authority:f.authority,runCheck:()=>{host++;throw Error('host forbidden');},runLinuxChecks:async()=>{native++;const req=await api.loadOwnedLinuxCheckRequest(f.ctx,'task',f.deps);return {schema:'pad-linux-check-observation.v1',binding:req.binding,verdict:'pass',results:req.checks.map(c=>({id:c.id,exitStatus:0,output:'# tests 1\n',tests:c.counter?1:null}))};}});
  assert.equal(native,1);assert.equal(host,0);assert.equal(result.reason,'checks-verified');assert.equal((await run(f.w,f.store,{id:'advance',type:'tick'},{authority:f.authority})).move,'advance');
});
// Why: a missing backend stays unavailable, with no implicit host fallback or positive evidence.
test('workflow Linux auto readiness unavailable parks without executing checks on the host',async t=>{
  const f=await fixture(t),exit=await import('../scripts/workflow_runner_exit.mjs');const config=join(f.repo,'.local/user.json');writeFileSync(config,JSON.stringify({schema:'pad-user.v1',checks:{runner:'auto'}}));const old=process.env.PAD_USER_CONFIG;process.env.PAD_USER_CONFIG=config;t.after(()=>{if(old===undefined)delete process.env.PAD_USER_CONFIG;else process.env.PAD_USER_CONFIG=old;});
  let native=0,host=0;const r=await exit.exitGateWorkflow(f.w,f.store,{id:'unavailable',type:'checks'},{platform:'linux',authority:f.authority,runCheck:()=>{host++;throw Error('host forbidden');},runLinuxChecks:async()=>{native++;return {verdict:'runner-unavailable',parkReason:'checks-runner-unavailable'};}});assert.equal(r.reason,'checks-runner-unavailable');assert.equal(native,1);assert.equal(host,0);
});
// Why: the repair loop must consume its real handover, carry gaps into an actual dispatch prompt, and not spend maxAttempts.
test('gap return consumes handover, redispatches its gaps, accepts repair and deduplicates checks',async t=>{
  const f=await fixture(t,1,true),exit=await import('../scripts/workflow_runner_exit.mjs'),core=await import('../scripts/workflow_runner_core.mjs'),{dispatchWorkflow}=await import('../scripts/workflow_runner_dispatch.mjs');
  const config=join(f.repo,'.local/user.json');writeFileSync(config,JSON.stringify({schema:'pad-user.v1',checks:{runner:'linux'}}));const old=process.env.PAD_USER_CONFIG;process.env.PAD_USER_CONFIG=config;t.after(()=>{if(old===undefined)delete process.env.PAD_USER_CONFIG;else process.env.PAD_USER_CONFIG=old;});
  let calls=0;const deps={authority:f.authority,runLinuxChecks:async()=>{calls++;const req=await api.loadOwnedLinuxCheckRequest(f.ctx,'task',f.deps);return {binding:req.binding,verdict:calls===1?'fail':'pass',results:req.checks.map(c=>({id:c.id,exitStatus:calls===1 && c.id==='lint'?1:0,output:'# tests 1\n',tests:c.counter?1:null}))};}};
  assert.equal((await exit.exitGateWorkflow(f.w,f.store,{id:'failed-checks',type:'checks'},deps)).reason,'checks-failed-returned');
  assert.equal((await run(f.w,f.store,{id:'blocked',type:'tick'},{authority:f.authority})).reason,'handover-unconsumed');
  const returned=await core.readAuthorizedStatus(f.w,f.store,f.authority);
  execFileSync('python3',[new URL('../scripts/session_handover.py',import.meta.url).pathname,'consume',returned.exit.handoverPath,'--root',f.repo],{cwd:f.repo,stdio:['ignore','pipe','pipe']});
  const retry=await run(f.w,f.store,{id:'retry',type:'tick'},{authority:f.authority});assert.equal(retry.move,'act');assert.equal(retry.attempts,1);
  let prompt;const driver={schema:'pad-worker-kind-adapter.v1',kind:'pi',host:'local',spawn:async()=>({ok:true,status:'spawned',role:'builder',paneId:'synthetic-pane',worktreePath:f.repo}),submit:async r=>{prompt=r.prompt;return {ok:true,status:'accepted',role:'builder',deliveryId:'synthetic-delivery'};},delivery:async()=>null};
  const dispatched=await dispatchWorkflow(f.w,f.store,{id:'redispatch',type:'dispatch'},driver,{authority:f.authority,readUserConfig:()=>({model:{policy:'subscription'}})});
  assert.equal(typeof prompt,'string',JSON.stringify(dispatched));
  assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf('\n')+1)).gaps.gapSet,['lint']);
  writeFileSync(join(f.repo,'artifact.md'),'repaired');f.git('add','.');f.git('commit','-m','repair');
  const active=await core.readAuthorizedStatus(f.w,f.store,f.authority),commit=f.git('rev-parse','HEAD');
  assert.equal((await run(f.w,f.store,{id:'repair-receipt',type:'receipt',receipt:f.receiptFor(active.intent,commit,'repaired')},{authority:f.authority})).reason,'verified-receipt');
  const event={id:'passing-checks',type:'checks'};assert.equal((await exit.exitGateWorkflow(f.w,f.store,event,deps)).reason,'checks-verified');assert.equal((await exit.exitGateWorkflow(f.w,f.store,event,deps)).duplicate,true);assert.equal(calls,2);
  assert.equal((await run(f.w,f.store,{id:'procedure',type:'procedure'},{authority:f.authority})).reason,'host-procedure-verified');
  assert.equal((await run(f.w,f.store,{id:'done',type:'tick'},{authority:f.authority})).phase,'done');
});
// Why: the authenticated checks claim is an exclusive durable intent, including across another event ID.
test('an in-flight host checks claim cannot be replaced to execute another effect',async t=>{
  const f=await fixture(t),exit=await import('../scripts/workflow_runner_exit.mjs');const config=join(f.repo,'.local/user.json');writeFileSync(config,JSON.stringify({schema:'pad-user.v1',checks:{runner:'host'}}));const old=process.env.PAD_USER_CONFIG;process.env.PAD_USER_CONFIG=config;t.after(()=>{if(old===undefined)delete process.env.PAD_USER_CONFIG;else process.env.PAD_USER_CONFIG=old;});
  let release,started;const blocked=new Promise(r=>{release=r;}),begun=new Promise(r=>{started=r;});
  const first=exit.exitGateWorkflow(f.w,f.store,{id:'host-one',type:'checks'},{authority:f.authority,runCheck:async()=>{started();await blocked;return {exitStatus:0,output:'# tests 1\n'};}});let cancelled=false;
  try {
    await begun;let secondCalls=0;const second=await exit.exitGateWorkflow(f.w,f.store,{id:'host-two',type:'checks'},{authority:f.authority,runCheck:async()=>{secondCalls++;return {exitStatus:0,output:'# tests 1\n'};}});assert.equal(secondCalls,0);assert.equal(second.reason,'checks-effect-unknown');
    await run(f.w,f.store,{id:'cancel-in-flight',type:'cancel'},{authority:f.authority});cancelled=true;
    const core=await import('../scripts/workflow_runner_core.mjs'),snapshot=JSON.parse(readFileSync(join(f.store,'state.json')));
    for(const type of ['checks','_checks']) assert.equal(core.transition(f.w,snapshot,{id:'late-'+type,type},{checksEventId:snapshot.exitClaim.eventId,exitObservation:()=>null}).state.phase,'cancelled');
  } finally {release();const late=await first;if(cancelled)assert.equal(late.phase,'cancelled','late checks must preserve owner cancellation');}
});
// Why: aborting the actual checks call cannot record a pass even if a child reports zero.
test('host checks cancellation is a non-passing observation',async t=>{
  const f=await fixture(t),exit=await import('../scripts/workflow_runner_exit.mjs'),controller=new AbortController();const config=join(f.repo,'.local/user.json');writeFileSync(config,JSON.stringify({schema:'pad-user.v1',checks:{runner:'host'}}));const old=process.env.PAD_USER_CONFIG;process.env.PAD_USER_CONFIG=config;t.after(()=>{if(old===undefined)delete process.env.PAD_USER_CONFIG;else process.env.PAD_USER_CONFIG=old;});
  const r=await exit.exitGateWorkflow(f.w,f.store,{id:'abort-checks',type:'checks'},{authority:f.authority,signal:controller.signal,runCheck:async()=>{controller.abort();return {exitStatus:0,output:'# tests 1\n'};}});assert.equal(r.reason,'checks-cancelled');
});
// Why: metadata tampering and a different checkout never bypass journal authentication.
test('changed saved workflow contract and untrusted context are refused',async t=>{
  const f=await fixture(t);await run(f.w,f.store,{id:'checks',type:'checks'},{authority:f.authority});
  const file=join(f.store,'workflow.json');const saved=JSON.parse(readFileSync(file));saved.maxAttempts=3;writeFileSync(file,JSON.stringify(saved));
  await assert.rejects(()=>api.loadOwnedLinuxCheckRequest(f.ctx,'task',f.deps));
  await assert.rejects(()=>api.loadOwnedLinuxCheckRequest({...f.ctx,isProjectTrusted:()=>false},'task',f.deps));
});
