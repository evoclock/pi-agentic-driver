import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const strings = limit => [
  {name:'absent',value:undefined}, {name:'empty',value:''},
  {name:'whitespace-only',value:' \t\r\n'}, {name:'valid',value:'value'},
  {name:'over-limit',value:'x'.repeat(limit + 1)},
];
export const numbers = limit => [
  {name:'zero',value:0}, {name:'negative',value:-1}, {name:'NaN',value:NaN},
  {name:'exact-limit',value:limit}, {name:'limit+1',value:limit + 1},
  {name:'huge',value:Number.MAX_VALUE},
];
export function pathCases() {
  mkdirSync(resolve('.scratch'), {recursive:true});
  const root = mkdtempSync(resolve('.scratch/boundaries-'));
  const regular = join(root,'regular.json');
  writeFileSync(regular, '{"schema":"pad-user.v1"}');
  symlinkSync(regular, join(root,'link'));
  mkdirSync(join(root,'directory'));
  execFileSync('mkfifo',[join(root,'fifo')],{timeout:5000});
  writeFileSync(join(root,'large.json'),JSON.stringify({payload:'x'.repeat(262145)}));
  return {root,cases:[
    {name:'regular',path:regular}, {name:'symlink',path:join(root,'link')},
    {name:'directory',path:join(root,'directory')}, {name:'FIFO',path:join(root,'fifo')},
    {name:'device',path:'/dev/null'}, {name:'oversize-json',path:join(root,'large.json')},
  ]};
}
