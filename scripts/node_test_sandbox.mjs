// Each native test worker gets private OS/JVM extraction state, not a shared /tmp module.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'test-gate-node-'));
for(const name of ['TMPDIR','TMP','TEMP']) process.env[name]=directory;
process.env.JAVA_TOOL_OPTIONS=((process.env.JAVA_TOOL_OPTIONS||'')+' -Djava.io.tmpdir='+JSON.stringify(directory)).trim();
process.on('exit',()=>rmSync(directory,{recursive:true,force:true}));
