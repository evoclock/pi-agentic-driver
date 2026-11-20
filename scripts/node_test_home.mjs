import {existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

export function runWithPrivateHome(command,args,{cwd=process.cwd(),env=process.env,capture=false}={}) {
  const home=mkdtempSync(join(tmpdir(),'pad-npm-home-'));
  try {
    const original=env.HOME||env.USERPROFILE||homedir();
    const userconfig=join(home,'npmrc');writeFileSync(userconfig,'');
    const child={...env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:join(home,'.config'),
      npm_config_userconfig:userconfig,npm_config_cache:env.npm_config_cache||env.NPM_CONFIG_CACHE||join(original,'.npm')};
    // The offline packed-install fixture deliberately uses its own cache selector.
    child.PI_PACKED_NPM_CACHE=env.PI_PACKED_NPM_CACHE||child.npm_config_cache;
    // Preserve checker data explicitly, not the agent's credential/config home.
    const jar=child.TLA2TOOLS||child.TLA2TOOLS_JAR||join(original,'.local/share/tlc/tla2tools.jar');
    // Freeze the selected resource before installed checks change cwd or HOME.
    if(existsSync(jar)) child.TLA2TOOLS=child.TLA2TOOLS_JAR=resolve(jar);
    const result=spawnSync(command,args,{cwd,env:child,...(capture?{encoding:'utf8',maxBuffer:16*1024*1024}:{stdio:'inherit'})});
    if(result.error) throw result.error;
    return {status:result.status??1,output:capture?(result.stdout||'')+(result.stderr||''):''};
  } finally {rmSync(home,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {process.exitCode=runWithPrivateHome('npm',['test']).status;}
  catch(error){console.error(error.message);process.exitCode=1;}
}
