import {existsSync,mkdirSync,mkdtempSync,readdirSync,cpSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runTlc} from '../tests/helpers/tlc.mjs';

const MAGIC=0x50414431, LIMIT=16*1024*1024;
const integer=n=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b;};
const text=value=>{const b=Buffer.from(value,'utf8');if(b.length>LIMIT)throw new Error('TLC request field too large');return Buffer.concat([integer(b.length),b]);};
const sha=value=>createHash('sha256').update(value).digest('hex');

export function validateBatchResults(jobs,results,workerPid=results[0]?.workerPid) {
  if(results.length!==jobs.length) throw new Error('TLC batch missing result count');
  for(const [index,job] of jobs.entries()) {
    const run=results[index];
    if(run.id!==job.id||run.digest!==job.digest) throw new Error('TLC batch attribution mismatch: '+job.id);
    if(run.workerPid!==workerPid) throw new Error('TLC batch pid attribution mismatch: '+job.id);
    if(!Number.isInteger(run.status)||typeof run.stdout!=='string'||typeof run.stderr!=='string'||!Number.isSafeInteger(run.workerPid)||run.workerPid<1) throw new Error('invalid TLC result: '+job.id);
    if(job.expectedStatus!==undefined&&run.status!==job.expectedStatus) throw new Error('TLC exit outcome mismatch: '+job.id);
  }
  return results;
}
function decode(buffer,jobs,expectedPid) {
  let offset=0;
  const number=()=>{if(offset+4>buffer.length)throw new Error('incomplete TLC frame');const n=buffer.readInt32BE(offset);offset+=4;return n;};
  const string=()=>{const n=number();if(n<0||n>LIMIT||offset+n>buffer.length)throw new Error('invalid TLC frame length');const s=buffer.subarray(offset,offset+n).toString('utf8');offset+=n;return s;};
  if(number()!==MAGIC||number()!==jobs.length) throw new Error('invalid TLC response protocol/count');
  const results=[];
  for(const job of jobs) {
    const id=string(),digest=string(),status=number();
    if(offset+8>buffer.length) throw new Error('missing TLC worker identity');
    const workerPid=Number(buffer.readBigInt64BE(offset)); offset+=8;
    results.push({id,digest,status,workerPid,stdout:string(),stderr:string(),skipped:false,mode:'single-jvm'});
  }
  if(offset!==buffer.length) throw new Error('trailing TLC response data');
  return validateBatchResults(jobs,results,expectedPid);
}

export function runTlcBatch(requests,{env=process.env,scratch=resolve('.scratch'),workerSource=fileURLToPath(new URL('./TlcBatch.java',import.meta.url))}={}) {
  if(!Array.isArray(requests)||!requests.length||requests.length>256) throw new Error('TLC batch requires 1..256 jobs');
  const ids=new Set();
  const jobs=requests.map((request,index)=>{
    const id=request.id??String(index),timeout=request.timeout??60000;
    if(typeof id!=='string'||!id||ids.has(id)||!Number.isInteger(timeout)||timeout<1||timeout>300000||basename(request.model)!==request.model||basename(request.config)!==request.config) throw new Error('invalid TLC batch job');
    ids.add(id);
    return {...request,id,timeout};
  });
  const jar=env.TLA2TOOLS||env.TLA2TOOLS_JAR,java=env.JAVA||'java';
  const version=spawnSync(java,['-version'],{env,encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  if(!jar||!existsSync(jar)||version.error||version.status!==0) {
    if(env.TLC_REQUIRED==='1') throw new Error('TLC required: working Java and TLA2TOOLS jar required');
    return jobs.map(job=>({id:job.id,digest:job.digest,skipped:true,reason:'TLC tools unavailable'}));
  }
  for(const job of jobs) job.digest=sha(Buffer.concat([readFileSync(join(job.source,job.model)),Buffer.from('\0'),readFileSync(join(job.source,job.config))]));
  const probe=spawnSync(java,['--list-modules'],{env,encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  const major=Number(((version.stdout||'')+'\n'+(version.stderr||'')).match(/(?:^|\n)(?:openjdk|java) version "(?:1\.)?(\d+)/)?.[1]);
  if(!Number.isInteger(major)||major<11||probe.status!==0||!probe.stdout?.includes('jdk.compiler@')) {
    return jobs.map(job=>{
      try {
        const run=runTlc({...job,env,scratch});
        const record={...run,id:job.id,digest:job.digest,mode:'isolated-jvm-fallback'};
        validateBatchResults([job],[record],run.workerPid);
        return record;
      } catch(error) {throw new Error('TLC isolated model aborted: '+job.id+': '+error.message,{cause:error});}
    });
  }
  scratch=resolve(scratch);
  mkdirSync(scratch,{recursive:true});
  const workspace=mkdtempSync(join(scratch,'tlc-batch-'));
  try {
    const prepared=jobs.map((job,index)=>{
      const cwd=join(workspace,'model-'+index);mkdirSync(cwd);
      for(const file of readdirSync(job.source)) if(/\.(tla|cfg)$/.test(file)) cpSync(join(job.source,file),join(cwd,file));
      return {...job,cwd};
    });
    const fields=[integer(MAGIC),text(resolve(jar)),integer(prepared.length)];
    for(const job of prepared) fields.push(text(job.id),text(job.digest),text(job.cwd),text(job.model),text(job.config),integer(job.timeout));
    const temporary=join(workspace,'java-tmp');mkdirSync(temporary);
    const command=[java,'-XX:+UseParallelGC','-Djava.io.tmpdir='+temporary,resolve(workerSource)];
    const run=spawnSync(command[0],command.slice(1),{cwd:workspace,env,input:Buffer.concat(fields),timeout:prepared.reduce((n,j)=>n+j.timeout,10000),maxBuffer:prepared.length*(2*LIMIT+65536)});
    if(run.error) throw run.error;
    if(run.status!==0) throw new Error(`TLC batch aborted (${run.status}): ${run.stderr?.toString()}`);
    return decode(run.stdout,prepared,run.pid).map((result,index)=>({...result,cwd:prepared[index].cwd,command}));
  } finally {rmSync(workspace,{recursive:true,force:true});}
}
