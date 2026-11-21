import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve, relative, dirname, posix } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { platform, homedir, tmpdir } from 'node:os';
import { loadDesignSpec } from './workflow_runner_spec.mjs';
import { loadUserConfig } from './workflow_runner_user_config.mjs';
import { recordOutputs, sameOutputs, outputsDigest, outputSnapshotMatches } from './workflow_runner_outputs.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v);
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const safe = p => typeof p === 'string' && p.length > 0 && !/[\\\u0000\r\n:]/.test(p) && !p.startsWith('/') && p === posix.normalize(p) && !p.split('/').includes('..');
const git = (repo,...args) => execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:262144}).trim();
const showAt = repo => (revision,path) => git(repo,'show',revision+':'+path);
const park = reason => ({ park: reason });
const validCheck = c => closed(c,['id','kind','command','cwd','timeoutSeconds','counter','covers']) && typeof c.id === 'string' && c.id.length > 0 && ['lint','types','test','invariant-test'].includes(c.kind) && Array.isArray(c.command) && c.command.length > 0 && c.command.length <= 64 && c.command.every(a => typeof a === 'string' && !a.includes('\0')) && c.command[0].length > 0 && (c.cwd === undefined || safe(c.cwd)) && (c.timeoutSeconds === undefined || Number.isSafeInteger(c.timeoutSeconds) && c.timeoutSeconds >= 1 && c.timeoutSeconds <= 600) && (!['test','invariant-test'].includes(c.kind) || ['node-tap','python-unittest','pytest','cargo'].includes(c.counter)) && (c.kind !== 'invariant-test' || Array.isArray(c.covers) && c.covers.length > 0 && c.covers.every(id => typeof id === 'string' && id.length > 0));
const validImport = c => closed(c,['id','kind','counter','covers','timeoutSeconds']) && validCheck({...c,command:['imported']});
export function validExitChecks(doc) {
  return closed(doc,['schema','fromGateRules','defaults']) && doc.schema === 'pad-exit-checks.v1' && Array.isArray(doc.fromGateRules) && doc.fromGateRules.every(validImport) && new Set(doc.fromGateRules.map(c => c.id)).size === doc.fromGateRules.length && Array.isArray(doc.defaults) && doc.defaults.every(validCheck) && doc.defaults.length + doc.fromGateRules.length <= 32;
}
export function validProgress(p) {
  return closed(p,['noProgressLimit','safetyCeiling']) && (p.noProgressLimit === undefined || Number.isSafeInteger(p.noProgressLimit) && p.noProgressLimit >= 2 && p.noProgressLimit <= 20) && (p.safetyCeiling === undefined || Number.isSafeInteger(p.safetyCeiling) && p.safetyCeiling >= (p.noProgressLimit ?? 2) && p.safetyCeiling <= 1000);
}
export function resolveProgress(w, config = {}) {
  const noProgressLimit = Math.min(20,w.progress?.noProgressLimit ?? config.progress?.noProgressLimit ?? 3);
  const safetyCeiling = Math.min(1000,w.progress?.safetyCeiling ?? config.progress?.safetyCeiling ?? 50);
  if (!validProgress({noProgressLimit,safetyCeiling})) throw Error('invalid progress');
  return {noProgressLimit,safetyCeiling};
}
export function resolveExitChecks(w, manifest, {show = showAt(w.repo)} = {}) {
  let defaults = {schema:'pad-exit-checks.v1',fromGateRules:[],defaults:[]};
  let bytes; try { bytes = show(w.revision, '.driver/exit-checks.json'); } catch { bytes = null; }
  try {
    if (bytes !== null) defaults = JSON.parse(bytes);
    if (!validExitChecks(defaults)) return park('checks-invalid');
    const checks = [...defaults.defaults];
    if (defaults.fromGateRules.length) {
      const rules = JSON.parse(show(w.revision, '.driver/gate-rules.json'));
      for (const declared of defaults.fromGateRules) {
        const matches = rules.checks?.filter(c => c.id === declared.id && c.kind === 'command');
        if (matches?.length !== 1) return park('checks-invalid');
        const rule = matches[0], timeoutSeconds = declared.timeoutSeconds ?? rule.timeoutSeconds;
        checks.push({...declared,command:rule.command,...(rule.cwd?{cwd:rule.cwd}:{}),...(timeoutSeconds !== undefined?{timeoutSeconds}:{})});
      }
    }
    checks.push(...(manifest.checks?.add ?? []));
    if (checks.length > 32 || checks.some(c => !validCheck(c)) || new Set(checks.map(c => c.id)).size !== checks.length) return park('checks-invalid');
    if (!checks.length) return { park: 'checks-undeclared' };
    const uncovered = (manifest.invariants ?? []).filter(i => !checks.some(c => c.kind === 'invariant-test' && c.covers.includes(i.id)));
    if (uncovered.length) return park('invariant-untested');
    return {checks,checksDigest:sha(canonical(checks))};
  } catch { return park('checks-invalid'); }
}
export function countTests(counter, output) {
  const patterns = {'node-tap':/^(?:#|ℹ) tests (\d+)\s*$/gm,'python-unittest':/\bRan (\d+) tests?\b/g,pytest:/^=*\s*((?:\d+ (?:passed|failed|skipped|deselected|xfailed|xpassed|errors?)(?:, )?)+)(?: in [\d.]+s)?\s*=*\s*$/gm,cargo:/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed\b/g};
  const matches = [...String(output).matchAll(patterns[counter] ?? /$^/g)];
  if (!matches.length) return null;
  const last = matches.at(-1);
  const count = counter === 'pytest' ? [...last[1].matchAll(/(\d+) (?:passed|failed|xfailed|xpassed)\b/g)].reduce((sum, match) => sum + Number(match[1]), 0) : Number(last[1]) + (counter === 'cargo' ? Number(last[2]) : 0);
  return Number.isSafeInteger(count) ? count : null;
}
export function detectMacosContainerRuntime({command,status,images,image,swVers,machine}) {
  return command === true && status === true && machine === 'arm64' && Number(String(swVers).split('.')[0]) >= 26 && typeof image === 'string' && image.length > 0 && Array.isArray(images) && images.includes(image) ? {ok:true,version:String(swVers)} : park('checks-runner-unavailable');
}
function detectRuntime(config) {
  const facts = {platform:platform(),macos:{ok:false}};
  if (facts.platform !== 'darwin') return facts;
  const command = (...args) => { try { return execFileSync(args[0],args.slice(1),{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH}}).trim(); } catch { return null; } };
  const status = command('container','system','status'), images = command('container','image','list','--format','json');
  let names=[]; try { names=JSON.parse(images).flatMap(i => [i.name,i.reference,...(i.tags ?? [])]).filter(Boolean); } catch { /* unavailable */ }
  const checked = detectMacosContainerRuntime({command:status !== null,status:typeof status === 'string' && /running/i.test(status) && !/not running/i.test(status),images:names,image:config.checks?.macos?.image,swVers:command('sw_vers','-productVersion'),machine:command('uname','-m')});
  facts.macos = checked.ok ? checked : {ok:false}; return facts;
}
export async function resolveCheckRunner(config = {}, {detect = detectRuntime} = {}) {
  const requested = config.checks?.runner ?? 'auto';
  if (requested === 'linux') return park('checks-runner-unavailable');
  if (requested === 'host') return {runner:'host',pickedBy:'requested'};
  if (!['macos','auto'].includes(requested)) return park('checks-runner-unavailable');
  const facts = await detect(config);
  if (facts?.platform === 'darwin' && facts.macos?.ok === true) return {runner:'macos',pickedBy:requested === 'auto'?'auto':'requested',image:config.checks?.macos?.image};
  return park('checks-runner-unavailable');
}
export function exitRequest(w,s) {
  if (!w.spec || !w.steps[s.step]?.worker || !s.pending || !s.intent || !['awaiting','parked'].includes(s.phase) || s.intent.epoch !== s.epoch || s.pending.dispatchId !== s.intent.dispatchId) return null;
  const loaded = loadDesignSpec(w); if (loaded.park) return {park:'checks-invalid'};
  const resolved = resolveExitChecks(w,loaded.manifest); if (resolved.park) return {...resolved,repo:w.repo,commit:s.pending.commit};
  let outputs;
  try {
    outputs = recordOutputs(w.repo,s.pending.commit,[w.steps[s.step].artifact]);
    if (s.pending.outputs && !sameOutputs(s.pending.outputs,outputs)) return {park:'checks-tree-changed'};
    if (!s.pending.outputs && outputs[0].sha256 !== w.steps[s.step].sha256) return {park:'checks-tree-changed'};
  } catch { return {park:'checks-tree-changed'}; }
  const config = loadUserConfig();
  return {repo:w.repo,commit:s.pending.commit,outputs,outputPaths:[w.steps[s.step].artifact],...resolved,manifest:loaded.manifest,progress:resolveProgress(w,config),previous:s.exit?.binding?.stepId === w.steps[s.step].id ? s.exit.gaps : null,config,
    binding:{taskId:s.taskId ?? s.intent.taskId,stepId:w.steps[s.step].id,epoch:s.epoch,writerId:s.intent.writerId,dispatchId:s.intent.dispatchId,commit:s.pending.commit,checksDigest:resolved.checksDigest,outputsDigest:outputsDigest(outputs)}};
}
const failedResult = r => r.exitStatus !== 0 || r.signal || r.timedOut || r.incomplete || (['test','invariant-test'].includes(r.kind) && !(r.tests >= 1));
export function buildGapList(results,manifest,previous) {
  const gaps = results.filter(failedResult).map(r => ({checkId:r.id,kind:r.kind,covers:r.covers ?? [],statements:(r.covers ?? []).map(id => manifest.invariants?.find(i => i.id === id)?.statement ?? ''),status:'fail',exitStatus:r.exitStatus,tests:r.tests}));
  const gapSet = [...new Set(gaps.map(g => g.checkId))].sort(), previousGapSet = [...new Set(previous?.gapSet ?? [])].sort();
  const staleStreak = canonical(gapSet) === canonical(previousGapSet) ? (previous?.staleStreak ?? 0)+1 : 1;
  return {schema:'pad-exit-gaps.v1',passIndex:(previous?.passes ?? 0)+1,gaps,gapSet,previousGapSet,staleStreak,passes:(previous?.passes ?? 0)+1};
}
const inspectTree = repo => ({head:git(repo,'rev-parse','HEAD'),dirty:git(repo,'status','--porcelain') !== ''});
const processCheck = ({command,cwd,env,timeoutMs,signal}) => new Promise(resolveResult => execFile(command[0],command.slice(1),{cwd,env,signal,timeout:timeoutMs,maxBuffer:4*1024*1024,shell:false,encoding:'utf8'},(error,stdout,stderr) => resolveResult({exitStatus:error ? Number.isInteger(error.code)?error.code:null : 0,signal:error?.signal ?? null,timedOut:error?.killed === true,incomplete:error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',output:String(stdout ?? '')+String(stderr ?? '')})));
function evidenceDirectory(repo,id) {
  const scratch=join(repo,'.scratch'); mkdirSync(scratch,{recursive:true}); if (realpathSync(scratch)!==scratch) throw Error('unsafe scratch');
  const directory=join(scratch,'workflow-runner','exit',id); mkdirSync(directory,{recursive:true}); if(realpathSync(directory)!==directory) throw Error('unsafe evidence'); return directory;
}
export async function observeExitChecks(request,deps = {}) {
  const base={evidenceId:'checks-'+randomUUID(),binding:structuredClone(request?.binding ?? null),results:[],runner:request?.runner,pickedBy:request?.pickedBy};
  const fail=(verdict,reason) => ({...base,verdict,parkReason:reason});
  if(request?.runner === 'linux') return fail('runner-unavailable','checks-runner-unavailable');
  if(!request?.repo || !request.commit || request.park) return fail('undeclared',request?.park ?? 'checks-incomplete');
  let selection;
  try { selection=request.runner ? {runner:request.runner,pickedBy:request.pickedBy ?? 'requested',image:request.image} : await resolveCheckRunner(request.config,deps); } catch { return fail('runner-unavailable','checks-runner-unavailable'); }
  if(selection.park || !['host','macos'].includes(selection.runner)) return fail('runner-unavailable','checks-runner-unavailable');
  Object.assign(base,selection);
  if(selection.runner === 'macos') {
    const detected=await (deps.detect ?? detectRuntime)(request.config ?? {checks:{macos:{image:request.image}}});
    if(detected?.platform !== 'darwin' || detected.macos?.ok !== true) return fail('runner-unavailable','checks-runner-unavailable');
  }
  if(!Array.isArray(request.checks) || !request.checks.length) return fail('undeclared','checks-undeclared');
  if(request.checks.some(c=>!validCheck(c))) return fail('incomplete','checks-invalid');
  const snapshot=deps.inspectTree ?? inspectTree; let before;
  try {before=await snapshot(request.repo);} catch{return fail('tree-changed','checks-tree-changed');}
  if(before.head !== request.commit || before.dirty) return fail('tree-changed','checks-tree-changed');
  if(request.outputs !== undefined) {
    if(request.binding?.outputsDigest !== outputsDigest(request.outputs) || !outputSnapshotMatches(request.repo,request.commit,request.outputs)) return fail('tree-changed','checks-tree-changed');
    if(request.outputPaths && !sameOutputs(request.outputs,recordOutputs(request.repo,request.commit,request.outputPaths))) return fail('tree-changed','checks-tree-changed');
  }
  const deadline=Date.now()+1800000; let directory;
  try { directory=evidenceDirectory(request.repo,base.evidenceId); } catch{return fail('incomplete','checks-incomplete');}
  for(const check of request.checks) {
    if(deps.signal?.aborted) return fail('incomplete','checks-cancelled');
    let cwd; try {cwd=realpathSync(resolve(request.repo,check.cwd ?? '.')); if(relative(realpathSync(request.repo),cwd).startsWith('..')) throw Error('unsafe cwd');} catch{return fail('incomplete','checks-invalid');}
    const env={PATH:process.env.PATH ?? '/usr/bin:/bin',HOME:homedir(),LANG:'C.UTF-8',TMPDIR:tmpdir(),CI:'1'};
    let command=[...check.command];
    if(selection.runner === 'macos') {
      const image=selection.image ?? request.config?.checks?.macos?.image;
      if(!image) return fail('runner-unavailable','checks-runner-unavailable');
      command=['container','run','--rm','--network','none','--mount','type=bind,source='+request.repo+',target=/work,readonly','--workdir',check.cwd?'/work/'+check.cwd:'/work','--cidfile',join(directory,'container-'+base.results.length+'.cid'),'-e','CI=1','-e','LANG=C.UTF-8','-e','HOME=/tmp','-e','TMPDIR=/tmp','-e','PATH=/usr/bin:/bin',...(request.config?.checks?.macos?.cpus?['-c',String(request.config.checks.macos.cpus)]:[]),...(request.config?.checks?.macos?.memory?['-m',request.config.checks.macos.memory]:[]),image,...check.command];
    }
    const timeoutMs=Math.min((check.timeoutSeconds ?? 120)*1000,deadline-Date.now()); if(timeoutMs <= 0) return fail('incomplete','checks-incomplete');
    let observed; try{observed=await (deps.runCheck ?? processCheck)({check,command,cwd,env,timeoutMs,signal:deps.signal});}catch{observed={exitStatus:null,incomplete:true,output:''};}
    if(deps.signal?.aborted) return fail('incomplete','checks-cancelled');
    const output=String(observed.output ?? ''), tests=['test','invariant-test'].includes(check.kind)?countTests(check.counter,output):null;
    const result={id:check.id,kind:check.kind,exitStatus:observed.exitStatus ?? null,signal:observed.signal ?? null,timedOut:observed.timedOut === true,incomplete:observed.incomplete === true,tests,covers:check.covers ?? [],outputSha256:sha(output)};
    base.results.push(result); writeFileSync(join(directory,'check-'+(base.results.length-1)+'.json'),JSON.stringify({id:check.id,sha256:result.outputSha256,preview:Buffer.from(output).subarray(0,4096).toString('utf8')}),{flag:'wx'});
  }
  let after; try{after=await snapshot(request.repo);}catch{return fail('tree-changed','checks-tree-changed');}
  if (after.head !== request.commit || after.dirty || request.outputs && !outputSnapshotMatches(request.repo,request.commit,request.outputs)) return fail('tree-changed','checks-tree-changed');
  return finishChecks(request,base);
}
function finishChecks(request,base) {
  const fail=(verdict,parkReason)=>({...base,verdict,parkReason});
  const gaps=buildGapList(base.results,request.manifest ?? {},request.previous); base.gaps=gaps;
  if(base.results.some(r=>['test','invariant-test'].includes(r.kind) && r.tests === 0)) return fail('zero-tests','checks-zero-tests');
  if(base.results.some(r=>r.incomplete || ['test','invariant-test'].includes(r.kind) && r.tests === null)) return fail('incomplete','checks-incomplete');
  if(gaps.gapSet.length) {
    const {noProgressLimit,safetyCeiling}=request.progress ?? {noProgressLimit:3,safetyCeiling:50};
    const staleStreak=gaps.staleStreak,passes=request.previous?.passes ?? 0;
    if(staleStreak >= noProgressLimit) return fail('no-progress','checks-no-progress');
    if(passes + 1 >= safetyCeiling) return fail('ceiling','checks-ceiling');
    return {...base,verdict:'fail',parkReason:null};
  }
  return {...base,verdict:'pass',parkReason:null};
}
export async function observeNativeLinuxChecks(request,deps={}) {
  const base={evidenceId:'checks-'+randomUUID(),binding:structuredClone(request.binding),results:[],runner:'linux',pickedBy:'requested'};
  const failed=(verdict,parkReason)=>({...base,verdict,parkReason});
  if(!outputSnapshotMatches(request.repo,request.commit,request.outputs)) return failed('tree-changed','checks-tree-changed');
  let observed;
  try {
    if(deps.runLinuxChecks) observed=await deps.runLinuxChecks(request.binding.taskId);
    else {
      const {executeLinuxGuestChecks}=await import('./enforcement/linux_microvm_checks_pi.js');
      observed=await executeLinuxGuestChecks({runId:request.binding.taskId},deps.signal,{cwd:request.repo,mode:'cli',hasUI:false});
    }
  } catch {return failed('incomplete','checks-incomplete');}
  if(observed?.verdict==='runner-unavailable') return failed('runner-unavailable','checks-runner-unavailable');
  if(!observed?.binding) return failed('incomplete','checks-incomplete');
  if(canonical(observed.binding)!==canonical(request.binding) || !outputSnapshotMatches(request.repo,request.commit,request.outputs)) return failed('tree-changed','checks-tree-changed');
  if(!Array.isArray(observed.results) || observed.results.length!==request.checks.length || new Set(observed.results.map(r=>r.id)).size!==request.checks.length) return failed('incomplete','checks-incomplete');
  for(const check of request.checks) {
    const row=observed.results.find(r=>r.id===check.id);
    if(!row || typeof row.output!=='string') return failed('incomplete','checks-incomplete');
    const tests=['test','invariant-test'].includes(check.kind)?countTests(check.counter,row.output):null;
    if(tests!==row.tests) return failed('incomplete','checks-incomplete');
    base.results.push({id:check.id,kind:check.kind,exitStatus:row.exitStatus,signal:row.signal ?? null,timedOut:row.timedOut===true,incomplete:row.incomplete===true,tests,covers:check.covers ?? [],outputSha256:sha(row.output)});
  }
  if(deps.signal?.aborted) return failed('incomplete','checks-cancelled');
  const finished=finishChecks(request,base);
  return observed.nonRetryable ? {...finished,verdict:'fail',nonRetryable:true,parkReason:observed.parkReason ?? 'checks-containment-tripped'} : finished;
}
export function matchingExit(request,observed,consumed = {}) {
  if(!request?.binding || !observed || !/^checks-[a-f0-9-]{36}$/.test(observed.evidenceId ?? '') || consumed[observed.evidenceId] || !Object.entries(request.binding).every(([k,v])=>observed.binding?.[k]===v)) return false;
  if(observed.verdict !== 'pass') return observed.verdict === 'fail' ? observed.gaps?.gapSet?.length > 0 : typeof observed.parkReason === 'string' && observed.parkReason.startsWith('checks-') || observed.parkReason === 'invariant-untested';
  return observed.gaps?.gapSet?.length === 0 && request.checks.every(c=>observed.results?.some(r=>r.id === c.id && !failedResult(r))) && observed.results.length === request.checks.length;
}
export function writeReturnHandover(run,gaps,{sessionHandover} = {}) {
  const directory=join(run.store,'handover'); mkdirSync(directory,{recursive:true}); if(realpathSync(directory)!==directory) throw Error('unsafe handover directory');
  const path=join(directory,'return-'+randomUUID()+'.json'), input=path+'.input.json';
  const claim=text=>[{label:'derived',text,pointer:run.commit}];
  const sections={goal:claim('Close the declared exit gaps.'),next_fix_plan_item:claim(gaps.gapSet.join(', ')),changed_files:[],state:claim('Exit checks failed; completion remains blocked.'),next_step:claim('Consume this handover before redispatch.'),open_items:claim(JSON.stringify(gaps)),decisions:[],Rejected:[]};
  writeFileSync(input,JSON.stringify(sections),{flag:'wx'});
  const command=['python3',new URL('./session_handover.py',import.meta.url).pathname,'write',path,'--root',run.repo,'--input',input];
  if(sessionHandover) sessionHandover(command); else execFileSync(command[0],command.slice(1),{cwd:run.repo,stdio:['ignore','pipe','pipe'],timeout:30000});
  return path;
}
export function returnHandoverConsumed(repo,exit) {
  if(!exit?.handoverPath || !safe(relative(repo,exit.handoverPath))) return false;
  try {const path=realpathSync(exit.handoverPath), marker=path+'.consumed'; if(path!==exit.handoverPath || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) return false; return JSON.parse(readFileSync(marker,'utf8')).handover === path;}catch{return false;}
}
export async function exitGateWorkflow(w,store,event,deps = {}) {
  if(event?.type !== 'checks') throw Error('invalid checks event');
  const {run,readAuthorizedStatus}=await import('./workflow_runner_core.mjs');
  const admitted=await run(w,store,event,{authority:deps.authority});
  if(admitted.duplicate) {const state=await readAuthorizedStatus(w,store,deps.authority); return state.checksResults?.[event.id]?{...state.checksResults[event.id],duplicate:true}:admitted;}
  if(admitted.reason !== 'checks-claimed' || !admitted.request) return admitted;
  const requested=admitted.request.config?.checks?.runner ?? 'auto';
  const autoLinux=requested==='auto' && (deps.platform ?? platform())==='linux';
  let observed = requested === 'linux' || autoLinux
    ? await observeNativeLinuxChecks(admitted.request,deps)
    : await observeExitChecks(admitted.request,deps);
  if(autoLinux) observed.pickedBy='auto';
  if(observed.verdict === 'fail' && !observed.nonRetryable) {try{observed.handoverPath=writeReturnHandover({repo:w.repo,store,commit:admitted.request.commit},observed.gaps,deps);}catch{observed={...observed,verdict:'incomplete',parkReason:'checks-incomplete'};}}
  if(deps.signal?.aborted) observed={...observed,verdict:'incomplete',parkReason:'checks-cancelled'};
  return run(w,store,{id:'checks-'+randomUUID(),type:'_checks'},{authority:deps.authority,checksEventId:event.id,exitObservation:()=>observed});
}
