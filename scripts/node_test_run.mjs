import {readFileSync,realpathSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {classifyTestFile} from './node_test_isolation.mjs';
export {classifyTestFile} from './node_test_isolation.mjs';
const sandbox=resolve(dirname(fileURLToPath(import.meta.url)),'node_test_sandbox.mjs');
let help;
function capabilities() {
  help??=spawnSync(process.execPath,['--help'],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  return {bootstrap:help.status===0&&help.stdout.includes('--import'),isolation:help.status===0&&help.stdout.includes('--experimental-test-isolation')};
}

export function planNodeTests({root=process.cwd(),argv,env=process.env}) {
  if(!Array.isArray(argv)||!argv.includes('--test')) throw new Error('native --test arguments required');
  root=resolve(root);
  const flags=argv.filter(a=>a.startsWith('--'));
  const files=argv.filter(a=>!a.startsWith('--')).map(a=>resolve(root,a));
  let distinct=false;
  try { distinct=new Set(files.map(f=>realpathSync(f))).size===files.length; } catch {}
  const known=flags.every(a=>['--test','--test-reporter=tap'].includes(a))&&files.length>0&&distinct;
  const caps=capabilities(),cache=new Map();
  if(!known) return {schema:'node-test-plan.v1',known:false,records:[],groups:[{safe:false,files,argv:[...(caps.bootstrap?['--import',sandbox]:[]),...argv]}]};
  const records=files.map(file=>({file,...(known&&!env.NODE_OPTIONS&&caps.isolation?classifyTestFile(file,root,cache):{safe:false,reason:'unknown flags, preloads or unsupported isolation'})}));
  const groups=[];
  for(const safe of [true,false]) {
    const selected=records.filter(r=>r.safe===safe).map(r=>r.file);
    if(!selected.length) continue;
    const args=known?[...flags,...(safe?['--experimental-test-isolation=none']:[]),...selected]:[...argv];
    groups.push({safe,files:selected,argv:[...(caps.bootstrap?['--import',sandbox]:[]),...args]});
    if(!known) break;
  }
  return {schema:'node-test-plan.v1',known,records,groups};
}

export function runNodeTests({root=process.cwd(),argv,capture=false,env=process.env}) {
  const plan=planNodeTests({root,argv,env}); let status=0,output='';
  const childEnv={...env}; delete childEnv.NODE_TEST_CONTEXT;
  for(const group of plan.groups) {
    const run=spawnSync(process.execPath,group.argv,{cwd:root,env:childEnv,...(capture?{encoding:'utf8',maxBuffer:32*1024*1024}:{stdio:'inherit'})});
    if(capture) output+=(run.stdout||'')+(run.stderr||'');
    if(run.error) throw run.error;
    if(run.status!==0) status=run.status??1;
  }
  return {status,output,plan};
}

if(process.argv[1]&&existsSync(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if(process.argv[2]==='--plan') {
      const request=JSON.parse(readFileSync(0,'utf8'));
      console.log(JSON.stringify(planNodeTests(request)));
    } else throw new Error('expected --plan');
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
