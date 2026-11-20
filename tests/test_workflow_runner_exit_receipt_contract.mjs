import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { initial, verifyReceipt, transition, decide } from '../scripts/workflow_runner_core.mjs';
const exit = await import(new URL('../scripts/workflow_runner_exit.mjs', import.meta.url)).catch(error => error);
const sha = b => createHash('sha256').update(b).digest('hex');
const broken = 'export const value = ;\n', repaired = 'export const value = 1;\n';
const observe = request => { assert.equal(typeof exit.observeExitChecks,'function','G8 checks observer required'); return exit.observeExitChecks(request); };
// Synthetic reducer fixture only: no authority service, worker, owner configuration or VM.
function fixture(t, bytes = broken) {
  assert.ok(!(exit instanceof Error), 'G8 exit checks module required');
  const parent = resolve('.scratch/g8-output-contract/tests'); mkdirSync(parent,{recursive:true});
  const repo = mkdtempSync(join(parent,'case-')); t.after(()=>rmSync(repo,{recursive:true,force:true}));
  const git = (...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','fixture'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  writeFileSync(join(repo,'.gitignore'),'.scratch/\n'); writeFileSync(join(repo,'artifact.mjs'),'export const value=0;\n');
  git('add','.'); git('commit','-m','base'); const base = git('rev-parse','HEAD');
  const w = {schema:'pad-workflow.v1',repo,revision:base,maxAttempts:2,spec:{schema:'pad-workflow-spec-ref.v1',manifest:'synthetic.json',sha256:'a'.repeat(64)},steps:[{id:'build',artifact:'artifact.mjs',sha256:sha(bytes),skill:{pack:'synthetic',version:'v1',step:'check'},worker:{role:'builder'}}]};
  function commit(content) { writeFileSync(join(repo,'artifact.mjs'),content); git('add','.'); git('commit','-m','output'); return git('rev-parse','HEAD'); }
  function state(at=base,dispatchId='dispatch-one') { const s=initial(w); s.phase='awaiting'; s.taskId='task'; s.intent={stepId:'build',taskId:'task',dispatchId,epoch:s.epoch,writerId:s.writerId,actor:'pad-runner',branch:'fixture',base:at}; return s; }
  function receipt(s,head,content=bytes) {return {stepId:'build',dispatchId:s.intent.dispatchId,epoch:s.epoch,dispatchEpoch:s.epoch,dispatchWriter:s.writerId,writerId:s.writerId,actor:'pad-runner',branch:'fixture',stepBaseHead:s.intent.base,revision:base,skillRef:'synthetic/v1/check',commit:head,check:'git-object-content',outputs:[{path:'artifact.mjs',sha256:sha(content)}]};}
  function request(s,head,content=bytes) {const outputs=[{path:'artifact.mjs',sha256:sha(content)}]; const checks=[{id:'syntax',kind:'lint',command:[process.execPath,'--check','artifact.mjs']}]; return {repo,commit:head,runner:'host',checks,manifest:{},outputs,binding:{taskId:'task',stepId:'build',epoch:s.epoch,writerId:s.writerId,dispatchId:s.intent.dispatchId,commit:head,checksDigest:sha(JSON.stringify(checks)),outputsDigest:sha(JSON.stringify(outputs))}};}
  function pending(s,head,content=bytes) {s.pending={stepId:'build',dispatchId:s.intent.dispatchId,epoch:s.epoch,writerId:s.writerId,stepBaseHead:s.intent.base,commit:head,outputs:[{path:'artifact.mjs',sha256:sha(content)}]}; return s;}
  return {repo,git,w,base,commit,state,receipt,request,pending};
}
// Why: the reported real-Git conflict must permit a same-path code repair, not a SHA redeclaration.
test('A records repaired worker bytes, then frozen checks certify precisely that receipt',async t=>{
  const f=fixture(t), first=f.commit(broken), one=f.state(); assert.equal(verifyReceipt(f.w,one,f.receipt(one,first)),true);
  assert.notEqual(spawnSync(process.execPath,['--check',join(f.repo,'artifact.mjs')]).status,0);
  const next=f.commit(repaired), two=f.state(first,'dispatch-two'), receipt=f.receipt(two,next,repaired);
  assert.equal(verifyReceipt(f.w,two,receipt),true,'a repair within the frozen path is admissible');
  const accepted=transition(f.w,two,{id:'repair',type:'receipt',receipt});
  assert.deepEqual(accepted.state.pending.outputs,receipt.outputs);
  const observed=await observe(f.request(two,next,repaired));
  assert.equal(observed.verdict,'pass'); assert.equal(observed.binding.outputsDigest,sha(JSON.stringify(receipt.outputs)));
  accepted.state.exit=observed; assert.equal(decide(f.w,accepted.state).move,'advance');
});
// Why: ChecksOnRecordedBytes rejects a pass for a different output digest even on the same commit.
test('passing check evidence cannot certify a substituted output digest',async t=>{
  const f=fixture(t,repaired), head=f.commit(repaired), s=f.pending(f.state(),head);
  s.exit=await observe(f.request(s,head)); assert.equal(s.exit.verdict,'pass');
  s.exit.binding.outputsDigest='0'.repeat(64); assert.equal(decide(f.w,s).move,'wait');
});
// Why: FrozenPathsOnly applies to the complete commit delta and to check-output declarations.
test('outside-path commit or check-output substitution never becomes accepted output',async t=>{
  const f=fixture(t,repaired), s=f.state(); writeFileSync(join(f.repo,'outside.mjs'),'outside');
  const head=f.commit(repaired); assert.equal(verifyReceipt(f.w,s,f.receipt(s,head)),false);
  const request=f.request(s,head); request.outputs[0].path='outside.mjs';
  assert.notEqual((await observe(request)).verdict,'pass');
});
// Why: LegacyUnchanged retains predeclared output SHA for every non-worker receipt.
test('non-worker fixed-byte contracts are unchanged',t=>{
  const f=fixture(t), s=f.state(); delete f.w.steps[0].worker;
  const first=f.commit(broken); assert.equal(verifyReceipt(f.w,s,f.receipt(s,first)),true);
  const next=f.commit(repaired), two=f.state(first,'dispatch-two'); assert.equal(verifyReceipt(f.w,two,f.receipt(two,next,repaired)),false);
});
// Why: NoTOCTOU reobserves the checkout at advance rather than trusting an earlier clean tree.
test('bytes changed after passing checks cannot advance',async t=>{
  const f=fixture(t,repaired), head=f.commit(repaired), s=f.pending(f.state(),head);
  s.exit=await observe(f.request(s,head)); assert.equal(s.exit.verdict,'pass');
  writeFileSync(join(f.repo,'artifact.mjs'),broken); assert.equal(decide(f.w,s).move,'wait');
});
// Why: RecordedActualBytes cannot be supplied by a worker label without hashing its actual Git blob.
test('a forged recorded digest is rejected even when legacy expected bytes happen to match',t=>{
  const f=fixture(t,repaired), s=f.state(), head=f.commit(repaired), receipt=f.receipt(s,head);
  receipt.outputs[0].sha256='0'.repeat(64); assert.equal(verifyReceipt(f.w,s,receipt),false);
});
