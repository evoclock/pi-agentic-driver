// Output identity is observed from Git, never granted by a worker's digest label.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, fstatSync, constants } from 'node:fs';
import { join, posix } from 'node:path';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value,(_,v)=>v && !Array.isArray(v) && typeof v==='object' ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
const git = (repo,...args)=>execFileSync('git',['-C',repo,...args],{stdio:['ignore','pipe','pipe'],maxBuffer:2e6});
const safe = path => typeof path==='string' && /^[a-zA-Z0-9._/-]+$/.test(path) && !path.startsWith('/') && path===posix.normalize(path) && !path.split('/').includes('..') && !path.endsWith('/');
export const outputsDigest = outputs => sha(canonical(outputs));
export function recordOutputs(repo,commit,paths) {
  if(!/^[a-f0-9]{40}$/.test(commit ?? '') || !Array.isArray(paths) || !paths.length || paths.length>12 || new Set(paths).size!==paths.length || !paths.every(safe)) throw Error('invalid output identity');
  return paths.map(path=>{
    const entry=git(repo,'ls-tree','-z',commit,'--',path).toString('utf8');
    if(!/^(100644|100755) blob [a-f0-9]{40}\t/.test(entry) || entry.split('\t')[1]!==path+'\0') throw Error('output must be a regular tracked blob');
    return {path,sha256:sha(git(repo,'show',commit+':'+path))};
  });
}
export function sameOutputs(left,right) {
  return Array.isArray(left) && left.length>0 && left.every(o=>o && Object.keys(o).sort().join(',')==='path,sha256' && safe(o.path) && /^[a-f0-9]{64}$/.test(o.sha256 ?? '')) && canonical(left)===canonical(right);
}
export function outputSnapshotMatches(repo,commit,outputs) {
  try {
    if(git(repo,'rev-parse','HEAD').toString('utf8').trim()!==commit || git(repo,'status','--porcelain','--untracked-files=all').length) return false;
    if(!sameOutputs(outputs,recordOutputs(repo,commit,outputs.map(o=>o.path)))) return false;
    return outputs.every(o=>{
      const fd=openSync(join(repo,o.path),constants.O_RDONLY|constants.O_NOFOLLOW);
      try {return fstatSync(fd).isFile() && sha(readFileSync(fd))===o.sha256;} finally {closeSync(fd);}
    });
  } catch {return false;}
}
