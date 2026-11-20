import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const file=new URL('../scripts/enforcement/linux_microvm_checks_runtime.js',import.meta.url);
const api=existsSync(file)?await import(file.href):{};
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(t,mode='safe') {
  const parent=resolve('.scratch/g8-ssh-checks/tests'); mkdirSync(parent,{recursive:true});
  const dir=mkdtempSync(join(parent,'case-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const script=join(dir,'fake-launcher.mjs');
  writeFileSync(script,`import {createHash} from 'node:crypto';
let input=''; for await(const b of process.stdin) input+=b;
const [line,bundle]=input.trim().split('\\n'), req=JSON.parse(line), mode=process.argv[2];
const sha=b=>createHash('sha256').update(b).digest('hex');
const pins={image:sha('image'),initramfs:sha('initramfs'),taxonomy:sha('taxonomy'),kernel:sha('kernel'),firecracker:sha('firecracker')};
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
if(req.schema==='pad-ssh-guest-probe.v1') {emit({type:'preflight',jobId:req.jobId,verified:true,pins:mode==='image'?{...pins,image:'0'.repeat(64)}:pins});process.exit(0);}
if(Object.keys(req).sort().join(',')!=='checkId,checkoutSha256,jobId,schema' || !bundle) process.exit(9);
emit({type:'preflight',jobId:req.jobId,verified:true,pins:mode==='image'?{...pins,image:'0'.repeat(64)}:mode==='initramfs'?{...pins,initramfs:'0'.repeat(64)}:mode==='kernel'?{...pins,kernel:'0'.repeat(64)}:mode==='firecracker'?{...pins,firecracker:'0'.repeat(64)}:pins});
const header={kind:'header',jobId:req.jobId,checkId:req.checkId,checkoutSha256:req.checkoutSha256,taxonomySha256:mode==='taxonomy'?'0'.repeat(64):pins.taxonomy};
const armed={kind:'armed',jobId:req.jobId};
const result={kind:'result',jobId:req.jobId,checkId:req.checkId,source:mode==='origin'?'host':'guest',commandSha256:mode==='wrong-command'?'0'.repeat(64):sha(JSON.stringify(['node','--check','artifact.mjs'])),exitStatus:mode==='trip'?126:0,outputBase64:Buffer.from('# tests 1\\n').toString('base64')};
const records=mode==='unarmed'?[header,result]:mode==='early-result'?[header,result,armed]:[header,armed,result];
const log=Buffer.from(records.map(r=>JSON.stringify(r)).join('\\n')+'\\n');
emit({type:'serial',bytes:log.toString('base64')});
if(mode==='drop') process.exit(255);
if(mode==='hang') await new Promise(r=>setTimeout(r,30000));
emit({type:'teardown',jobId:req.jobId,destroyed:mode!=='destroy',watchdog:mode==='watchdog',logSha256:mode==='log'?'0'.repeat(64):sha(log)});
`);
  const input={host:'fixture.invalid',commandSha256:sha(JSON.stringify(['node','--check','artifact.mjs'])),jobId:'12345678-1234-4234-8234-123456789abc',checkId:'syntax',checkout:{bytes:Buffer.from('fixture').toString('base64'),sha256:sha('fixture')},pins:{image:sha('image'),initramfs:sha('initramfs'),taxonomy:sha('taxonomy'),kernel:sha('kernel'),firecracker:sha('firecracker')}};
  let calls=0;
  const spawnProcess=(command,args,options)=>{
    calls++; assert.equal(command,'ssh'); assert.equal(args.at(-1),'pad-guest-check-v1'); assert.ok(args.includes('-s')); assert.ok(args.includes('RemoteCommand=none'));
    // Why: the fixture rejects shell wrappers even though its fake launcher is only a local child.
    assert.equal(args.some(a=>/bash|sh -c|python|base64|\/usr\/local/.test(a)),false,'only the SSH subsystem, never a remote shell command');
    return spawn(process.execPath,[script,mode],options);
  };
  const call=async options=>{assert.equal(typeof api.runSSHCheck,'function','fixed SSH guest-check transport required'); return api.runSSHCheck(input,{spawnProcess,...options});};
  const probe=async()=>{assert.equal(typeof api.probeSSHChecks,'function','non-launching readiness probe required');return api.probeSSHChecks({host:input.host,jobId:input.jobId,pins:input.pins},{spawnProcess});};
  return {input,call,probe,get calls(){return calls;}};
}
// Why: readiness verifies backend pins without claiming a guest armed or launching a VM.
test('non-launching probe verifies pins without fabricating arming',async t=>{const f=fixture(t),r=await f.probe();assert.equal(r.status,'completed');assert.equal(r.pinsVerified,true);assert.equal(r.armed,undefined);assert.equal(f.calls,1);const bad=await fixture(t,'image').probe();assert.equal(bad.status,'failed');});
// Why: the positive witness crosses an actual process stream without launching SSH or a VM.
test('fixed SSH subsystem validates both pinned preflight and armed serial evidence',async t=>{
  const f=fixture(t), r=await f.call(); assert.equal(r.status,'completed'); assert.equal(r.exitStatus,0); assert.equal(f.calls,1);
  assert.equal(sha(Buffer.from(r.logBase64,'base64')),r.logSha256); assert.equal(r.output,'# tests 1\n');
});
// Why: PinnedBeforeBoot and NoGuestWithoutArmedKillswitch require all image pins, not just a guest claim.
test('image and initramfs mismatches never certify a guest result',async t=>{
  for(const mode of ['image','initramfs','kernel','firecracker']) {const f=fixture(t,mode),r=await f.call(); assert.equal(r.status,'failed'); assert.equal(f.calls,1);}
});
// Why: a matching host pin alone does not prove the serial supervisor actually armed before its result.
test('missing, late or wrong-taxonomy armed evidence is never accepted',async t=>{
  for(const mode of ['unarmed','early-result','taxonomy']) {const f=fixture(t,mode),r=await f.call(); assert.equal(r.status,'failed'); assert.equal(r.retryable,false);}
});
// Why: LogIntegrity compares exact decoded serial bytes to the teardown digest.
test('serial log digest mismatch fails closed',async t=>{const r=await fixture(t,'log').call(); assert.equal(r.status,'failed');});
// Why: DisconnectNeverPass cannot infer teardown or retry from an SSH process closing.
test('SSH drop after a result never passes and is not retried',async t=>{const f=fixture(t,'drop'),r=await f.call(); assert.equal(r.status,'failed'); assert.equal(r.retryable,false); assert.equal(f.calls,1);});
// Why: WatchdogNeverPass is independent of successful syntax output.
test('host watchdog firing invalidates an otherwise passing result',async t=>{const r=await fixture(t,'watchdog').call(); assert.equal(r.status,'failed');});
// Why: TripNeverPass preserves exit126 and logs as failed checks, never successful containment proof.
test('killswitch trip returns failed exit126 and retains the verified serial log',async t=>{const r=await fixture(t,'trip').call(); assert.equal(r.status,'failed'); assert.equal(r.exitStatus,126); assert.equal(r.reason,'killswitch-trip'); assert.ok(r.logBase64); assert.equal(r.retryable,false);});
// Why: DestroyedBeforePass requires observed teardown, not process exit alone.
test('unverified VM destruction cannot pass',async t=>{const r=await fixture(t,'destroy').call(); assert.equal(r.status,'failed');});
// Why: OnlyGuestResults rejects host/proof rows disguised as a check result.
test('host-labelled result is rejected',async t=>{const r=await fixture(t,'origin').call(); assert.equal(r.status,'failed');});
// Why: an allowlisted check ID cannot certify a different command from the frozen check.
test('wrong executed-command digest never passes',async t=>{const r=await fixture(t,'wrong-command').call(); assert.equal(r.status,'failed');});
// Why: cancellation dominates a late result and terminates only this call's child process.

test('cancellation and local deadline fail without retry',async t=>{
  const f=fixture(t,'hang'),controller=new AbortController(); const pending=f.call({signal:controller.signal});
  setTimeout(()=>controller.abort(),50); const cancelled=await pending; assert.equal(cancelled.status,'failed'); assert.equal(cancelled.reason,'cancelled');
  const timed=await fixture(t,'hang').call({timeoutMs:50}); assert.equal(timed.status,'failed'); assert.equal(timed.reason,'watchdog');
});
// Why: transport inputs are typed identities, never model-provided shell/argv or changed bundle bytes.
test('extra argv and mismatched bundle fail before any process starts',async t=>{
  const f=fixture(t); f.input.command=['echo','unsafe']; const extra=await f.call(); assert.equal(extra.status,'failed'); assert.equal(f.calls,0);
  delete f.input.command; f.input.checkout.sha256='0'.repeat(64); const digest=await f.call(); assert.equal(digest.status,'failed'); assert.equal(f.calls,0);
});
