import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,writeFileSync,rmSync,readFileSync,mkdirSync,statSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runTlc} from './helpers/tlc.mjs';
import {spawnSync} from 'node:child_process';

const root=resolve(new URL('..',import.meta.url).pathname);
async function load() {
  const file=process.env.PAD_TLC_BATCH_SOURCE || join(root,'scripts/tlc_batch.mjs');
  assert.ok(existsSync(file),'bounded TLC JVM batch runner is required');
  return import(pathToFileURL(file).href);
}
const jar=process.env.TLA2TOOLS || process.env.TLA2TOOLS_JAR || join(homedir(),'.local/share/tlc/tla2tools.jar');
function fixtures(t,n=0) {
  const source=mkdtempSync(join(tmpdir(),'tlc-batch-model-'));
  t.after(()=>rmSync(source,{recursive:true,force:true}));
  writeFileSync(join(source,'MC.tla'),`---- MODULE MC ----\nEXTENDS Naturals\nVARIABLE x\nInit == x = ${n}\nNext == x' = x\nSafe == x = ${n}\nProbe${n} == x # ${n}\nEventuallyOther == <> (x = ${n+1})\n====\n`);
  for(const [name,obligation] of [['safe.cfg','INVARIANT Safe'],['unsafe.cfg',`INVARIANT Probe${n}`],['temporal.cfg','PROPERTY EventuallyOther']]) writeFileSync(join(source,name),`INIT Init\nNEXT Next\n${obligation}\nCHECK_DEADLOCK FALSE\n`);
  return source;
}

// Why: installed wrappers read TLA2TOOLS, so private HOME must not strand a parent-only checker alias.
test('private HOME runs the installed TLC test with canonical, alias and relative parent jars',async t=>{
  assert.ok(existsSync(jar),'real TLC jar is required for private-HOME installed-checker proof');
  const helper=join(root,'scripts/node_test_home.mjs');
  assert.ok(existsSync(helper),'private HOME runner is required');
  const {runWithPrivateHome}=await import(pathToFileURL(helper).href);
  const tools=mkdtempSync(join(tmpdir(),'installed-tlc-home-'));t.after(()=>rmSync(tools,{recursive:true,force:true}));
  // This is a launcher, not a checker stub: both outcomes come from the installed jar and Java.
  writeFileSync(join(tools,'tlc'),'#!/bin/sh\nwork=$(mktemp -d "${TMPDIR:-/tmp}/installed-tlc-XXXXXX") || exit 1\ntrap \'rm -rf "$work"\' EXIT\n"${JAVA:-java}" -Djava.io.tmpdir="$work" -cp "${TLA2TOOLS:-$HOME/.local/share/tlc/tla2tools.jar}" tlc2.TLC "$@"\n',{mode:0o755});
  const installed=spawnSync('which',['tlc'],{encoding:'utf8'});
  const launcher=installed.status===0?installed.stdout.trim():join(tools,'tlc');
  const script=statSync(launcher).size<=32768?readFileSync(launcher,'utf8'):'';
  t.diagnostic(JSON.stringify({launcher,readsCanonical:Boolean(script.match(/\bTLA2TOOLS\b/)),readsAlias:Boolean(script.match(/\bTLA2TOOLS_JAR\b/)),readsHome:Boolean(script.match(/\bHOME\b/))}));
  const aliasTools=join(tools,'alias-only');mkdirSync(aliasTools);
  // Observed CI contract: reads TLA2TOOLS_JAR, not TLA2TOOLS; still executes the real checker.
  writeFileSync(join(aliasTools,'tlc'),readFileSync(join(tools,'tlc'),'utf8').replace('${TLA2TOOLS:-','${TLA2TOOLS_JAR:-'),{mode:0o755});
  for(const [contract,path] of [['installed',installed.status===0?process.env.PATH:tools+':'+process.env.PATH],['alias-only',aliasTools+':'+process.env.PATH]]) {
  for(const [mode,name,value] of [['alias','TLA2TOOLS_JAR',resolve(jar)],['canonical','TLA2TOOLS',resolve(jar)],['relative','TLA2TOOLS',relative(root,resolve(jar))],['precedence','TLA2TOOLS',resolve(jar)]]) {
    const javaTemp=join(tools,contract+'-'+mode);mkdirSync(javaTemp);
    const env={...process.env,PATH:path,TLA2TOOLS:'',TLA2TOOLS_JAR:'',[name]:value,JAVA_TOOL_OPTIONS:(process.env.JAVA_TOOL_OPTIONS||'')+' -Djava.io.tmpdir='+JSON.stringify(javaTemp)};
    if(mode==='precedence') env.TLA2TOOLS_JAR=join(tools,'missing.jar');
    delete env.NODE_TEST_CONTEXT;
    const run=runWithPrivateHome(process.execPath,['--test','--test-reporter=tap','--test-name-pattern=installed TLC',join(root,'tests/test_model_fidelity_crash.mjs')],{cwd:root,env,capture:true});
    assert.equal(run.status,0,contract+'/'+mode+' via '+launcher+'\n'+run.output);
    assert.match(run.output,/# tests 1\b/);assert.match(run.output,/# pass 1\b/);assert.match(run.output,/# skipped 0\b/);
    assert.match(run.output,/TLC2 Version/);assert.match(run.output,/unsafe\.cfg: exit 12/);
  }
  }
});

// Why: a pooled exit code, digest or output from a neighbour must not be claimed by another model.
test('batch conformance rejects swapped identity and exit attribution',async()=>{
  const {validateBatchResults}=await load();
  const jobs=[{id:'safe',digest:'a',expectedStatus:0},{id:'negative',digest:'b',expectedStatus:12}];
  const records=[{id:'safe',digest:'a',status:0,stdout:'',stderr:'',workerPid:1},{id:'negative',digest:'b',status:12,stdout:'Invariant Probe is violated',stderr:'',workerPid:1}];
  validateBatchResults(jobs,records);
  assert.throws(()=>validateBatchResults(jobs,[records[1],records[0]]),/attribution/);
  assert.throws(()=>validateBatchResults(jobs,[{...records[0],status:12},{...records[1],status:0}]),/exit|outcome/);
  assert.throws(()=>validateBatchResults(jobs,[records[0]]),/missing|count/);
  assert.throws(()=>validateBatchResults(jobs,[records[0],{...records[1],digest:'a'}]),/attribution/);
  assert.throws(()=>validateBatchResults(jobs,[records[0],{...records[1],workerPid:42}]),/pid|attribution/);
});

// Why: repeated module names and safe/unsafe alternation must reset TLC state inside one real JVM.
test('one JVM preserves each fresh-run status, temporal result and named violation',async t=>{
  const {runTlcBatch}=await load();
  if(!existsSync(jar)) { if(process.env.TLC_REQUIRED==='1'||process.env.PAD_TEST_GATE_NESTED==='1') assert.fail('TLC jar required'); t.skip('installed TLC jar unavailable'); return; }
  const a=fixtures(t,0), b=fixtures(t,1), env={...process.env,TLA2TOOLS:jar,TLC_REQUIRED:'1'};
  const jobs=[{id:'a-safe',source:a,model:'MC.tla',config:'safe.cfg',expectedStatus:0},{id:'a-bad',source:a,model:'MC.tla',config:'unsafe.cfg',expectedStatus:12},{id:'b-safe',source:b,model:'MC.tla',config:'safe.cfg',expectedStatus:0},{id:'b-bad',source:b,model:'MC.tla',config:'unsafe.cfg',expectedStatus:12},{id:'a-temporal',source:a,model:'MC.tla',config:'temporal.cfg',expectedStatus:13},{id:'again',source:a,model:'MC.tla',config:'safe.cfg',expectedStatus:0}];
  const before=readFileSync(join(a,'MC.tla'),'utf8');
  let runs;
  assert.doesNotThrow(()=>{runs=runTlcBatch(jobs,{env});});
  assert.equal(runs.length,jobs.length);
  if(process.env.PAD_TEST_GATE_NESTED==='1') assert.equal(runs[0].mode,'single-jvm','mutation proof must exercise the reusable Java backend, not only its fallback');
  if(runs[0].mode==='single-jvm') assert.equal(new Set(runs.map(r=>r.workerPid)).size,1,'model checks must share one JVM');
  else assert.ok(runs.every(r=>r.mode==='isolated-jvm-fallback'),'unsupported source launcher keeps fresh-JVM checks');
  for(const [i,job] of jobs.entries()) {
    const fresh=runTlc({...job,env});
    assert.ok(Number.isSafeInteger(fresh.workerPid)&&fresh.workerPid>0,'fresh JVM identity must come from native process observation');
    assert.ok(fresh.command.includes('-Djava.io.tmpdir='+fresh.cwd),'fresh checks need private writable Java temp even with a read-only root');
    assert.equal(runs[i].status,fresh.status,job.id);
    assert.equal(runs[i].id,job.id);
  }
  assert.match(runs[1].stdout,/Invariant Probe0 is violated/);
  assert.match(runs[3].stdout,/Invariant Probe1 is violated/);
  assert.match(runs[4].stdout,/Temporal properties were violated/);
  assert.equal(readFileSync(join(a,'MC.tla'),'utf8'),before);
});

// Why: the canonical registered-control path must use batching and retain named-negative checks.
test('registered control verification retains each batch identity and rejects a different named violation',async t=>{
  await load();
  if(!existsSync(jar)){t.skip('installed TLC jar unavailable');return;}
  const source=fixtures(t), module=pathToFileURL(join(root,'scripts/model_negative_controls.mjs')).href;
  writeFileSync(join(source,'.gitignore'),'.scratch/\n');
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','model']]) {
    const git=spawnSync('git',args,{cwd:source,encoding:'utf8'});
    assert.equal(git.status,0,git.stderr);
  }
  const model={path:join(source,'MC.tla'),cfgs:['safe.cfg'],controls:[{config:'unsafe.cfg',kind:'invariant',expected:'Probe0'},{config:'temporal.cfg',kind:'property',expected:'EventuallyOther'}]};
  const code=`import assert from 'node:assert/strict';import{verifyControls}from ${JSON.stringify(module)};const model=${JSON.stringify(model)};const result=verifyControls({errors:[],models:[model]});assert.throws(()=>verifyControls({errors:[],models:[{...model,controls:[{...model.controls[0],expected:'WrongProbe'}]}]}),/intended negative result absent/);console.log(JSON.stringify(result.map(r=>({status:r.status,workerPid:r.workerPid,id:r.id,digest:r.digest}))));`;
  const run=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:source,env:{...process.env,TLA2TOOLS:jar,TLC_REQUIRED:'1'},encoding:'utf8',timeout:60000});
  assert.equal(run.status,0,run.stderr);
  const records=JSON.parse(run.stdout);
  assert.deepEqual(records.map(r=>r.status),[0,12,13]);
  // Why: the digest-format test below rejects source/config evidence without its binding.
  assert.ok(records.every(r=>typeof r.workerPid==='number'&&r.id&&/^[a-f0-9]{64}$/.test(r.digest)),'canonical outcomes require batch attribution');
});

// Why: a per-model deadline is not replaced by an unbounded batch timeout or a partial success.
test('expired model aborts the batch without publishing a successful partial set',async t=>{
  const {runTlcBatch}=await load();
  if(!existsSync(jar)){t.skip('installed TLC jar unavailable');return;}
  const source=fixtures(t);
  assert.throws(()=>runTlcBatch([{id:'deadline-model',source,model:'MC.tla',config:'safe.cfg',timeout:1}],{env:{...process.env,TLA2TOOLS:jar,TLC_REQUIRED:'1'}}),/deadline-model|timeout|aborted/);
});

// Why: working Java without a compiler or source launcher must still perform isolated native checks.
test('unsupported reuse capabilities retain real isolated checks and attributed timeouts',async t=>{
  const {runTlcBatch}=await load();
  if(!existsSync(jar)){t.skip('installed TLC jar unavailable');return;}
  const source=fixtures(t), actual=process.env.JAVA||'java';
  for(const older of [false,true]) {
    const wrapper=join(source,older?'java-old-launcher':'java-no-compiler');
    const version=older?`if [ "$1" = "-version" ]; then printf 'openjdk version "9.0.4"\\n'; exit 0; fi\n`:'';
    const modules=older?'java.base@9\\njdk.compiler@9\\n':'java.base@27\\n';
    const quoted="'"+actual.replaceAll("'","'\\''")+"'";
    writeFileSync(wrapper,`#!/bin/sh\n${version}if [ "$1" = "--list-modules" ]; then printf '${modules}'; exit 0; fi\nexec ${quoted} "$@"\n`,{mode:0o755});
    const env={...process.env,JAVA:wrapper,TLA2TOOLS:jar,TLC_REQUIRED:'1'};
    const jobs=[['safe.cfg',0],['unsafe.cfg',12],['temporal.cfg',13]].map(([config,expectedStatus])=>({id:config,source,model:'MC.tla',config,expectedStatus}));
    const runs=runTlcBatch(jobs,{env});
    assert.deepEqual(runs.map(r=>r.status),[0,12,13]);
    assert.ok(runs.every(r=>r.mode==='isolated-jvm-fallback'));
    assert.equal(new Set(runs.map(r=>r.workerPid)).size,3);
    assert.match(runs[1].stdout,/Invariant Probe0 is violated/);
    assert.match(runs[2].stdout,/Temporal properties were violated/);
    assert.throws(()=>runTlcBatch([{...jobs[0],id:'fallback-deadline',timeout:1}],{env}),/fallback-deadline/);
  }
});

// Why: official mutation proof cannot turn an unavailable TLC jar into a passing skipped suite.
test('official mutation context refuses a skipped live Java proof',async()=>{
  await load();
  const env={...process.env,TLA2TOOLS:'/nonexistent/tla2tools.jar',TLC_REQUIRED:'0',PAD_TEST_GATE_NESTED:'1'};
  delete env.NODE_TEST_CONTEXT;
  const run=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern=one JVM preserves',new URL(import.meta.url).pathname],{env,encoding:'utf8',timeout:30000});
  assert.notEqual(run.status,0,run.stdout+run.stderr);
  assert.match(run.stdout,/TLC jar required/);
});

// Why: required formal checks cannot turn missing Java or a jar into a skipped proof.
test('required tooling absence fails loudly',async()=>{
  const {runTlcBatch}=await load();
  assert.throws(()=>runTlcBatch([{id:'missing',source:root,model:'MC.tla',config:'safe.cfg'}],{env:{TLC_REQUIRED:'1',TLA2TOOLS:'/nonexistent/tla.jar',JAVA:'/nonexistent/java'}}),/required|Java|TLC/);
});
