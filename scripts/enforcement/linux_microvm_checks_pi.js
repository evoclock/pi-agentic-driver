import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, realpathSync, readdirSync, existsSync, lstatSync, fstatSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isNativeTuiContext } from './native_tui_context.js';
import { countTests } from '../workflow_runner_exit.mjs';
import { productionChecksDrivers } from './linux_microvm_checks_runtime.js';
import { approvalPaths, verifyApprovals, authorizeApproval, reserveApprovalUse } from './approval_ledger_pi.js';

export const GUEST_CHECK_ACTION = 'guest-check';
export const GUEST_CHECKS_TOOL = 'agentic_linux_microvm_checks';
export const GUEST_TAXONOMY_SHA256 = '0b194cdfd86f23fd68c2685c2ccfc556a0e311e2973b1ff619c6c78791d65fcd';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v);
const closed = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');
const git = (repo,...args) => execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:20*1024*1024}).trim();
const profilePath = options => options.profile ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(),'.pi','agent');
const now = options => options.now ? options.now() : new Date();
const unavailable = () => ({schema:'pad-linux-check-observation.v1',verdict:'runner-unavailable',parkReason:'checks-runner-unavailable',results:[],authorityCreated:false});
const incomplete = () => ({schema:'pad-linux-check-observation.v1',verdict:'incomplete',parkReason:'checks-incomplete',results:[],authorityCreated:false});
function durableJSON(path,value) {
  const fd=openSync(path,'wx',0o600);
  try {writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);} finally {closeSync(fd);}
  const directory=openSync(join(path,'..'),'r');try {fsyncSync(directory);} finally {closeSync(directory);}
}
function repositoryOf(request,profile) {
  // Matching basenames are not identity. Reuse native spawn's owner-policy
  // source, without its unrelated primary-clone placement constraint.
  const policy=JSON.parse(readFileSync(approvalPaths(profile).relayers,'utf8'));
  const owner=policy?.githubOwner;
  if(policy?.schema!=='relay-authority.v1' || typeof owner!=='string' || !/^[A-Za-z0-9-]{1,39}$/.test(owner)) throw Error('repository owner unavailable');
  const origin=git(request.repo,'config','--local','--get','remote.origin.url');
  const match=origin.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9][A-Za-z0-9-]{0,63})(?:\.git)?$/);
  const name=match?.[2];
  if(match?.[1]!==owner || !/^[a-z][a-z0-9-]{0,63}$/.test(name ?? '') || request.repository && request.repository!==name) throw Error('repository mismatch');
  return name;
}
function selectStanding(profile,repository,time) {
  const paths=approvalPaths(profile);
  const entries=verifyApprovals(paths.ledger,paths.head).slice().reverse();
  for(const entry of entries) {
    if(entry.kind!=='standing' || !Number.isFinite(Date.parse(entry.expiresAt)) || Date.parse(entry.expiresAt)<=time.getTime() || entry.scope?.repo!==repository || entry.scope.actions?.length!==1 || entry.scope.actions[0]!==GUEST_CHECK_ACTION || ['paths','prs','branches','models','roles','kinds','accounts'].some(key=>(entry.scope[key]?.length ?? 0)>0)) continue;
    try {authorizeApproval(profile,entry.id,{tier:1,repository,action:GUEST_CHECK_ACTION},time);return entry;} catch { /* no usable scope */ }
  }
  throw Error('standing guest-check authorization unavailable');
}
function reservationStillValid(profile,entry,useId,repository,time) {
  const paths=approvalPaths(profile), current=verifyApprovals(paths.ledger,paths.head).find(row=>row.id===entry.id);
  const config=JSON.parse(readFileSync(paths.relayers,'utf8'));
  // The current reservation already owns capacity; do not mistake its final
  // allowed use for exhaustion. This fence grants no additional reservation.
  return current?.hash===entry.hash && current.kind==='standing' && current.scope.repo===repository && current.scope.actions.length===1 && current.scope.actions[0]===GUEST_CHECK_ACTION && Number.isFinite(Date.parse(current.expiresAt)) && Date.parse(current.expiresAt)>time.getTime() && !config.revokedIds?.includes(entry.id) && config.relayers?.some(r=>r.relayer===entry.relayer && r.channel===entry.channel && r.maxTier>=1) && readFileSync(paths.uses,'utf8').split('\n').filter(Boolean).map(JSON.parse).some(use=>use.use===useId && use.ledgerId===entry.id && use.action===GUEST_CHECK_ACTION && use.target===repository && use.result==='reserved');
}
function checkRequest(request,context,runId) {
  if(request?.schema!=='pad-linux-check-request.v1' || request.runId!==runId || !/^[a-f0-9-]{36}$/.test(request.requestId ?? '') || realpathSync(request.repo)!==realpathSync(context.cwd) || git(request.repo,'rev-parse','HEAD')!==request.commit || request.binding?.taskId!==runId || request.binding.commit!==request.commit || !hash(request.binding.checksDigest)) throw Error('request mismatch');
  if(!Array.isArray(request.checks) || !request.checks.length || request.checks.length>32 || new Set(request.checks.map(c=>c.id)).size!==request.checks.length || sha(canonical(request.checks))!==request.binding.checksDigest) throw Error('checks mismatch');
  for(const check of request.checks) {
    if(typeof check.id!=='string' || !check.id || !Array.isArray(check.command) || !check.command.length || check.command.length>64 || check.command.some(a=>typeof a!=='string' || a.includes('\0')) || !check.command[0] || (check.timeoutSeconds!==undefined && (!Number.isSafeInteger(check.timeoutSeconds) || check.timeoutSeconds<1 || check.timeoutSeconds>600))) throw Error('invalid command');
  }
  const archive=Buffer.from(request.checkout?.bytes ?? '','base64');
  if(!archive.length || archive.length>16*1024*1024 || sha(archive)!==request.checkout.sha256 || !hash(request.checkout.sha256)) throw Error('checkout mismatch');
  const expected=execFileSync('git',['-C',request.repo,'archive','--format=tar',request.commit],{maxBuffer:16*1024*1024});
  if(sha(expected)!==request.checkout.sha256 || /^(120000|160000) /m.test(git(request.repo,'ls-tree','-r',request.commit))) throw Error('unsafe checkout');
}
function checkTarget(target) {
  if(target?.transport==='ssh-subsystem-v1') return target.mode==='ssh' && closed(target,['schema','mode','transport','sshTarget','pins','imageManifestSha256','checks']) && target.schema==='pad-linux-check-target.v1' && typeof target.sshTarget==='string' && closed(target.pins,['image','initramfs','taxonomy','kernel','firecracker']) && ['image','initramfs','taxonomy'].every(k=>hash(target.pins[k])) && Object.values(target.pins).every(hash) && target.pins.taxonomy===GUEST_TAXONOMY_SHA256;
  return target?.jobPayload==='exec /usr/bin/python3 /g8-supervisor.py' && closed(target.checksRuntime,['archive','sha256']) && typeof target.checksRuntime.archive==='string' && target.checksRuntime.archive.startsWith('/') && !/[\0\r\n]/.test(target.checksRuntime.archive) && hash(target.checksRuntime.sha256);
}
function checkGuestResult(request,target,result) {
  if(result?.schema!=='pad-linux-check-result.v1' || result.source!=='guest' || result.requestId!==request.requestId || result.guestRun!==request.requestId || canonical(result.binding)!==canonical(request.binding) || result.checkoutSha256!==request.checkout.sha256 || result.runtimeSha256!==(target.pins?.image ?? target.checksRuntime?.sha256) || result.cancelled!==false || result.teardown?.verified!==true || result.containment?.verified!==true) throw Error('guest evidence mismatch');
  if(!Array.isArray(result.results) || result.results.length!==request.checks.length || new Set(result.results.map(r=>r.id)).size!==result.results.length) throw Error('missing guest results');
  for(const check of request.checks) {
    const row=result.results.find(r=>r.id===check.id);
    if(!row || row.commandSha256!==sha(canonical(check.command)) || typeof row.output!=='string' || Buffer.byteLength(row.output)>4*1024*1024 || (row.exitStatus!==null && !Number.isInteger(row.exitStatus))) throw Error('command evidence mismatch');
    if(['test','invariant-test'].includes(check.kind) && countTests(check.counter,row.output)!==row.tests) throw Error('test count mismatch');
  }
}
function claimRequest(request,authorization) {
  const directory=join(request.repo,'.local','workflow-runner',request.runId,'native-checks');
  mkdirSync(directory,{recursive:true}); if(realpathSync(directory)!==directory) throw Error('unsafe intent directory');
  const lock=join(directory,'writer.lock'), fd=openSync(lock,'wx',0o600);
  let released=false;
  const release=()=>{
    if(released) return; released=true;
    try {const actual=lstatSync(lock),own=fstatSync(fd);if(actual.ino===own.ino && actual.dev===own.dev) unlinkSync(lock);} finally {closeSync(fd);}
  };
  try {
    writeFileSync(fd,JSON.stringify({requestId:request.requestId}));fsyncSync(fd);
    for(const file of readdirSync(directory).filter(name=>name.endsWith('.intent.json'))) {
      const resultPath=join(directory,file.replace('.intent.json','.result.json'));
      if(!existsSync(resultPath) || realpathSync(resultPath)!==resultPath || !lstatSync(resultPath).isFile()) throw Error('unknown prior native effect');
      if(JSON.parse(readFileSync(resultPath,'utf8')).nonRetryable===true) throw Error('prior containment trip requires recovery');
    }
    const stem=join(directory,request.requestId);
    durableJSON(stem+'.intent.json',{requestId:request.requestId,binding:request.binding,checkoutSha256:request.checkout.sha256,authorization});
    return {release,saveEvidence:value=>durableJSON(stem+'.guest.json',value),finish:value=>durableJSON(stem+'.result.json',{schema:value.schema,requestId:value.requestId,binding:value.binding,verdict:value.verdict,nonRetryable:value.nonRetryable===true,authorization,containment:value.containment?{tripped:value.containment.tripped,logSha256:value.containment.logSha256}:null})};
  } catch(error) {release();throw error;}
}
async function armedReady(request,target,signal,options,drivers) {
  if(sha(readFileSync(new URL('./guest_containment_taxonomy.v1.json',import.meta.url)))!==GUEST_TAXONOMY_SHA256) return false;
  const ready=await (options.probeGuestChecks ?? drivers.probe)?.(request,target,signal);
  return (target.transport==='ssh-subsystem-v1'?ready?.pinsVerified===true:ready?.armed===true) && ready.taxonomySha256===GUEST_TAXONOMY_SHA256 && ready.requestId===request.requestId;
}
async function executeChecks(params,signal,context,options,drivers) {
  if(!closed(params,['runId']) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(params.runId ?? '') || signal?.aborted) return unavailable();
  const attended=isNativeTuiContext(context);
  const unattended=context?.hasUI===false && [undefined,'headless','cli','batch','json','print'].includes(context?.mode);
  if(!attended && !unattended) return unavailable();
  if(attended && options.isolationSwitch?.get()!==true) return unavailable();
  let request,target,standing,profile,repository,useId;
  const admitted=()=>{
    try {return !signal?.aborted && (!attended || options.isolationSwitch?.get()===true) && repositoryOf(request,profile)===repository && reservationStillValid(profile,standing,useId,repository,now(options));} catch {return false;}
  };
  try {
    request=await (options.loadChecksRequest ?? drivers.loadRequest)?.(context,params.runId);
    checkRequest(request,context,params.runId);
    target=await (options.loadChecksTarget ?? drivers.loadTarget)?.();
    if(!checkTarget(target)) return unavailable();
    profile=profilePath(options);repository=repositoryOf(request,profile);standing=selectStanding(profile,repository,now(options));
    const reserved=await reserveApprovalUse(profile,standing.id,{tier:1,repository,action:GUEST_CHECK_ACTION});useId=reserved.useId;
    if(attended) {
      // Consent is the authenticated standing grant, never a per-run UI answer.
      const consent=admitted();
      if(consent!==true || options.isolationSwitch?.get()!==true) return unavailable();
    } else if(!admitted()) return unavailable();
    if(signal?.aborted || !await armedReady(request,target,signal,options,drivers)) return unavailable();
  } catch {return unavailable();}
  if(signal?.aborted) return unavailable();
  let claim,authorization;
  try {
    const fresh=await (options.loadChecksRequest ?? drivers.loadRequest)?.(context,params.runId);
    if(canonical(fresh)!==canonical(request)) return unavailable();
    checkRequest(request,context,params.runId);
    if(!admitted() || !await armedReady(request,target,signal,options,drivers) || !admitted()) return unavailable();
    authorization={mode:attended?'attended':'unattended',ledgerId:standing.id,useId,expiresAt:standing.expiresAt};
    claim=claimRequest(request,authorization);
  } catch {return incomplete();}
  try {
    const current=async()=>{
      if(!admitted()) return false;
      const fresh=await (options.loadChecksRequest ?? drivers.loadRequest)?.(context,params.runId);
      const freshTarget=await (options.loadChecksTarget ?? drivers.loadTarget)?.();
      return admitted() && canonical(fresh)===canonical(request) && canonical(freshTarget)===canonical(target);
    };
    let result;
    try {if(!admitted()) return unavailable();if(!await current()) return admitted()?incomplete():unavailable();result=await (options.runGuestChecks ?? drivers.run)?.(request,target,signal,current);} catch {return admitted()?incomplete():unavailable();}
    if(!admitted()) return unavailable();
    if(Buffer.byteLength(JSON.stringify(result ?? null))>16*1024*1024) return incomplete();
    try {claim.saveEvidence(result ?? null);} catch {return incomplete();}
    try {
      if(!admitted()) return unavailable();
      const fresh=await (options.loadChecksRequest ?? drivers.loadRequest)?.(context,params.runId);
      if(canonical(fresh)!==canonical(request)) return incomplete();
      if(!await current()) return admitted()?incomplete():unavailable();
      checkGuestResult(request,target,result);
      const base={schema:'pad-linux-check-observation.v1',binding:request.binding,requestId:request.requestId,authorization,results:result.results,containment:result.containment,authorityCreated:false};
      if(result.containment.tripped===true) {
        if(result.containment.exitStatus!==126 || typeof result.containment.log!=='string' || sha(result.containment.log)!==result.containment.logSha256) return incomplete();
        const failed={...base,verdict:'fail',exitStatus:126,nonRetryable:true,parkReason:'checks-containment-tripped'};claim.finish(failed);return failed;
      }
      if(result.containment.armed!==true || result.containment.taxonomySha256!==GUEST_TAXONOMY_SHA256) return incomplete();
      const pass=result.results.every(row=>row.exitStatus===0 && !row.signal && !row.timedOut && (!['test','invariant-test'].includes(request.checks.find(c=>c.id===row.id).kind) || row.tests>=1));
      const observed={...base,verdict:pass?'pass':'fail',parkReason:null};claim.finish(observed);return observed;
    } catch {return incomplete();}
  } finally {claim.release();}
}
export async function executeLinuxGuestChecks(params,signal,context,options={}) {
  return executeChecks(params,signal,context,options,productionChecksDrivers(options));
}
export function registerLinuxGuestChecks(pi,options={},drivers={}) {
  drivers={...productionChecksDrivers(options),...drivers};
  pi.registerTool({name:GUEST_CHECKS_TOOL,label:'Workflow guest checks',description:'Run only the frozen receipt checks with native attended consent or a scoped standing guest-check grant; mandatory pinned containment killswitch.',parameters:{type:'object',additionalProperties:false,required:['runId'],properties:{runId:{type:'string',pattern:'^[a-zA-Z][a-zA-Z0-9_-]{0,80}$',maxLength:81}}},
    async execute(_id,params,signal,_update,context) {
      const value=await executeChecks(params,signal,context,options,drivers);
      const summary={...value,results:value.results?.map(({output,...row})=>({...row,outputSha256:sha(output ?? '')})),containment:value.containment?{...value.containment,log:undefined}:undefined};
      return {content:[{type:'text',text:JSON.stringify(summary)}],details:value};
    }});
}
