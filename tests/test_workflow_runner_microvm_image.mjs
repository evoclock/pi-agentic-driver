import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const api=await import('../scripts/enforcement/linux_microvm_checks_runtime.js').catch(error=>error);
const {loadSSHChecksTarget,runConfiguredSSHChecks}=api;
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(t) {
  assert.ok(!(api instanceof Error),'guest runtime module required');
  assert.equal(typeof loadSSHChecksTarget,'function','manifest-bound target loader required');
  assert.equal(typeof runConfiguredSSHChecks,'function','fixed-check runtime required');
  const parent=resolve('.scratch/g8b-image-target');mkdirSync(parent,{recursive:true});
  const profile=mkdtempSync(join(parent,'case-'));t.after(()=>rmSync(profile,{recursive:true,force:true}));
  const command=['node','--test','one.mjs'];
  const row={command,cwd:'.',timeoutSeconds:10,commandSha256:sha(JSON.stringify(command))};
  const pins=Object.fromEntries(['image','initramfs','taxonomy','kernel','firecracker'].map(k=>[k,sha(k)]));
  pins.taxonomy='0b194cdfd86f23fd68c2685c2ccfc556a0e311e2973b1ff619c6c78791d65fcd';
  const manifest={schema:'pad-guest-image-manifest.v1',testudoCommit:'92796bc7d487b6c0a8b9128be87653f17898742b',sourceDateEpoch:1,checks:{syntax:row},pins,
    sources:{monitor:'d2aa2b380bb2855fcb75a1feeda72877f8e59f658697b409d8581503a5b4e97c',taxonomy:pins.taxonomy,supervisor:sha(readFileSync(new URL('../scripts/guest_checks_supervisor.py',import.meta.url))),busybox:sha('busybox')}};
  const target={schema:'pad-linux-check-target.v1',sshTarget:'fixture.invalid',pins,imageManifestSha256:''};
  const save=()=>{const bytes=JSON.stringify(manifest);target.imageManifestSha256=sha(bytes);writeFileSync(join(profile,'linux-microvm-checks-image.json'),bytes);writeFileSync(join(profile,'linux-microvm-checks.json'),JSON.stringify(target));};
  save();
  const request={requestId:'12345678-1234-4234-8234-123456789abc',binding:{taskId:'fixture'},checkout:{bytes:Buffer.from('fixture').toString('base64'),sha256:sha('fixture')},checks:[{id:'syntax',kind:'test',counter:'node-tap',command,timeoutSeconds:10}]};
  return {profile,manifest,target,request,save};
}
// Why: a local target alone cannot enable a backend without an exact pinned image/check manifest.
test('production target requires the matching source-pinned image manifest',t=>{
  const f=fixture(t);const target=loadSSHChecksTarget({profile:f.profile});
  assert.equal(target.imageManifestSha256,f.target.imageManifestSha256);assert.deepEqual(target.pins,f.manifest.pins);assert.deepEqual(target.checks,f.manifest.checks);
  f.manifest.sourceDateEpoch=2;
  writeFileSync(join(f.profile,'linux-microvm-checks-image.json'),JSON.stringify(f.manifest));
  assert.throws(()=>loadSSHChecksTarget({profile:f.profile}),/digest mismatch/);
});
// Why: even a new manifest digest cannot bless changed Testudo monitor sources or a mismatched kernel pin.
test('changed source identity and artifact pins fail closed',t=>{
  const f=fixture(t);f.manifest.sources.monitor='0'.repeat(64);f.save();assert.throws(()=>loadSSHChecksTarget({profile:f.profile}),/manifest mismatch/);
  f.manifest.sources.monitor='d2aa2b380bb2855fcb75a1feeda72877f8e59f658697b409d8581503a5b4e97c';f.manifest.sources.supervisor='0'.repeat(64);f.save();
  assert.throws(()=>loadSSHChecksTarget({profile:f.profile}),/manifest mismatch/);
  f.manifest.sources.supervisor=sha(readFileSync(new URL('../scripts/guest_checks_supervisor.py',import.meta.url)));f.manifest.pins={...f.manifest.pins,kernel:'0'.repeat(64)};f.save();
  assert.throws(()=>loadSSHChecksTarget({profile:f.profile}),/manifest mismatch/);
});
// Why: the fixed image map must agree with every frozen command, directory and timeout before any transport effect.
test('unmapped command directory or timeout never invokes SSH',async t=>{
  const f=fixture(t),target=loadSSHChecksTarget({profile:f.profile});let calls=0;
  const send=async()=>{calls++;throw Error('unexpected transport');};
  for(const change of [{command:['node','other.mjs']},{cwd:'other'},{timeoutSeconds:9}]) {
    await assert.rejects(runConfiguredSSHChecks({...f.request,checks:[{...f.request.checks[0],...change}]},target,undefined,async()=>true,send),/pinned image/);
  }
  assert.equal(calls,0);
});
// Why: fresh native authorization and claim checks fence both launch and acceptance of a late result.
test('revocation before launch or after transport cannot publish a result',async t=>{
  const f=fixture(t),target=loadSSHChecksTarget({profile:f.profile});let calls=0;
  const send=async()=>{calls++;return {status:'completed',exitStatus:0,output:'# tests 1\n',logBase64:'',logSha256:sha('')};};
  await assert.rejects(runConfiguredSSHChecks(f.request,target,undefined,async()=>false,send),/fenced/);assert.equal(calls,0);
  let current=0;await assert.rejects(runConfiguredSSHChecks(f.request,target,undefined,async()=>++current===1,send),/fenced/);assert.equal(calls,1);
});
// Why: only a validated transport outcome may be aggregated, with the original claim and observed test denominator.
test('configured transport retains request binding and fixed command identity',async t=>{
  const f=fixture(t),target=loadSSHChecksTarget({profile:f.profile});let job;
  const r=await runConfiguredSSHChecks(f.request,target,undefined,async()=>true,async input=>{job=input.jobId;assert.deepEqual(input.pins,target.pins);return {status:'completed',exitStatus:0,output:'# tests 1\n',logBase64:'',logSha256:sha('')};});
  assert.match(job,/^[a-f0-9-]{36}$/);assert.deepEqual(r.binding,f.request.binding);assert.equal(r.results[0].tests,1);assert.equal(r.results[0].commandSha256,target.checks.syntax.commandSha256);assert.equal(r.containment.tripped,false);
});
// Why: a transport trip is terminal and marks remaining checks unexecuted rather than retrying them.
test('trip never starts a second check',async t=>{
  const f=fixture(t);f.manifest.checks.second={...f.manifest.checks.syntax};f.save();const target=loadSSHChecksTarget({profile:f.profile});
  f.request.checks.push({...f.request.checks[0],id:'second'});let calls=0;
  const r=await runConfiguredSSHChecks(f.request,target,undefined,async()=>true,async()=>{calls++;return {status:'failed',reason:'killswitch-trip',exitStatus:126,output:'',logBase64:'',logSha256:sha('')};});
  assert.equal(calls,1);assert.equal(r.containment.tripped,true);assert.equal(r.results[1].notRun,true);assert.equal(r.results[1].exitStatus,126);
});
