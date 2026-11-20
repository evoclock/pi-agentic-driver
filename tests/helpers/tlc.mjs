import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function runTlc({source, model, config, env = process.env, timeout = 60000, scratch = resolve('.scratch')}) {
  const jar = env.TLA2TOOLS || env.TLA2TOOLS_JAR;
  const java = env.JAVA || 'java';
  const probe = spawnSync(java, ['-version'], {env, encoding:'utf8', timeout:5000});
  if (!jar || !existsSync(jar) || probe.status !== 0) {
    const reason = 'TLC not run: working Java and TLA2TOOLS or TLA2TOOLS_JAR required';
    if (env.TLC_REQUIRED === '1') throw new Error(`TLC required: ${reason}`);
    return {skipped:true, reason};
  }
  mkdirSync(scratch, {recursive:true});
  const cwd = mkdtempSync(join(scratch, 'tlc-'));
  try {
    for (const file of readdirSync(source)) {
      if (/\.(tla|cfg)$/.test(file)) cpSync(join(source, file), join(cwd, file));
    }
    const args = ['-XX:+UseParallelGC', '-Djava.io.tmpdir=' + cwd, '-cp', resolve(jar), 'tlc2.TLC', '-workers', '1', '-metadir', join(cwd,'meta'), '-config', config, model];
    const result = spawnSync(java, args, {cwd, env, encoding:'utf8', timeout, maxBuffer:16 * 1024 * 1024});
    if (result.error) throw result.error;
    return {status:result.status, workerPid:result.pid, signal:result.signal, stdout:result.stdout, stderr:result.stderr, cwd, command:[java,...args], skipped:false};
  } finally { rmSync(cwd, {recursive:true,force:true}); }
}
