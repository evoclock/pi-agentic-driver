import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';

const localPipeline = ['sfw','rsvg-convert','git','make','bash','sh','curl','gh','buildkite-agent','tar','chmod','mkdir'];

export function requiredGateTools({root = process.cwd(), checks} = {}) {
  checks ??= JSON.parse(readFileSync(resolve(root,'.driver/gate-rules.json'),'utf8')).checks;
  const tools = new Map();
  const add = (name, neededBy) => tools.set(name,{name,neededBy:[tools.get(name)?.neededBy,neededBy].filter(Boolean).join('; ')});
  for (const name of localPipeline) add(name,'local gate / Buildkite host commands');
  add('janus/node_modules/.bin/tsc','janus-types: tsc --noEmit -p janus/tsconfig.json');
  add('janus/node_modules/.bin/tsx','janus-tests: npm test');
  for (const check of checks) if (check.kind === 'command' && check.command?.length) add(check.command[0],`${check.id}: ${check.command.join(' ')}`);
  return [...tools.values()];
}

function executable(name,{root,env}) {
  const paths = name.includes('/') ? [resolve(root,name)] : (env.PATH || '').split(delimiter).filter(Boolean).map(path => join(path,name));
  return paths.some(path => { try { accessSync(path,constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
}

export function checkGateTools({root = process.cwd(), env = process.env, available = name => executable(name,{root,env})} = {}) {
  const tools = requiredGateTools({root});
  const missing = tools.filter(tool => !available(tool.name));
  if (missing.length) throw new Error(missing.map(tool => `missing gate tool: ${tool.name}; needed by ${tool.neededBy}`).join('\n'));
  return tools;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { checkGateTools(); console.log('local gate tools: OK'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
