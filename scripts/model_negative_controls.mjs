import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runTlcBatch } from './tlc_batch.mjs';

export const DIRECTIVES = ['SPECIFICATION','INIT','NEXT','INVARIANT','PROPERTY','CONSTRAINT','ACTION_CONSTRAINT','CONSTANT','CONSTANTS','SYMMETRY','VIEW','CHECK_DEADLOCK','ALIAS','POSTCONDITION','RL_REWARD','RL_ACTION'];
const configTokens = text => text.match(/"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g) ?? [];

function stripConfigComments(text) {
  let result = '', depth = 0, lineComment = false, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i], pair = text.slice(i, i + 2);
    if (lineComment) {
      if (char === '\n') { lineComment = false; result += '\n'; }
      continue;
    }
    if (depth) {
      if (pair === '(*') { depth++; i++; }
      else if (pair === '*)') { depth--; i++; }
      else if (char === '\n') result += '\n';
      continue;
    }
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (pair === '(*') { depth = 1; result += ' '; i++; continue; }
    if (pair === '\\*') { lineComment = true; result += ' '; i++; continue; }
    result += char;
    if (char === '"') quoted = true;
  }
  if (depth) throw new Error('unterminated block comment in TLC configuration');
  return result;
}

export function obligations(text, kind) {
  const clean = stripConfigComments(text);
  const tokens = configTokens(clean);
  const found = [];
  let collecting = false;
  for (const token of tokens) {
    if ([...DIRECTIVES,'INVARIANTS','PROPERTIES'].includes(token)) collecting = (kind === 'property' ? /^PROPERT(Y|IES)$/ : kind === 'invariant' ? /^INVARIANTS?$/ : /^(INVARIANTS?|PROPERT(Y|IES))$/).test(token);
    else if (collecting && /^[A-Za-z_][A-Za-z_0-9]*$/.test(token)) found.push(token);
  }
  return kind === 'property' ? found : [...new Set(found)];
}

export function allowlistGrowth(previous, current) {
  return Object.entries(current).flatMap(([model, entry]) => {
    if (!previous[model]) return [`${model}: allowlist cannot gain models`];
    return (entry.missing ?? []).filter(name => !previous[model].missing.includes(name)).map(name => `${model}: allowlist cannot gain ${name}`);
  });
}

export function coverageGaps(names, controls) {
  controls = controls.filter(control => control.kind !== 'reachability');
  return names.filter(name => !controls.some(control => control.expected === name));
}

function walk(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? walk(join(path,entry.name)) : [join(path,entry.name)]);
}

export function auditModels({root = '.', controls, allowlist} = {}) {
  controls ??= JSON.parse(readFileSync(join(root,'config/model-negative-controls.v1.json'), 'utf8'));
  allowlist ??= JSON.parse(readFileSync(join(root,'config/model-negative-controls.allowlist.v1.json'), 'utf8'));
  const errors = [];
  if (root === '.') {
    const previous = spawnSync('git',['show','origin/main:config/model-negative-controls.allowlist.v1.json'],{encoding:'utf8'});
    if (previous.status === 0) errors.push(...allowlistGrowth(JSON.parse(previous.stdout),allowlist));
  }
  const models = [];
  for (const path of [...walk(join(root,'docs')), ...walk(join(root,'skills'))].filter(path => path.endsWith('.tla'))) {
    const key = path.replace(/^\.\//,'').slice(root === '.' ? 0 : root.length + 1);
    const stem = basename(path,'.tla');
    const cfgs = readdirSync(dirname(path)).filter(name => name.endsWith('.cfg') && !/unsafe|probe/.test(name) && (name === `${stem}.cfg` || name.startsWith(`${stem}-`) || (name === 'safe.cfg' && readdirSync(dirname(path)).filter(n => n.endsWith('.tla')).length === 1)));
    const probes = readdirSync(dirname(path)).filter(name => name.startsWith(`${stem}-`) && /-probe.*\.cfg$/.test(name.slice(stem.length)));
    if (!cfgs.length && !probes.length) continue;
    const names = [...new Set(cfgs.flatMap(name => obligations(readFileSync(join(dirname(path),name),'utf8'))))];
    const entries = controls[key] ?? [];
    const missing = coverageGaps(names, entries);
    if (missing.length && !allowlist[key]?.reason) errors.push(`${key}: missing negative controls: ${missing.join(', ')}`);
    if (!missing.length && allowlist[key]) errors.push(`${key}: covered model must leave allowlist`);
    if (allowlist[key] && JSON.stringify(allowlist[key].missing) !== JSON.stringify(missing)) errors.push(`${key}: allowlist must shrink when coverage changes`);
    for (const config of probes) {
      const sentinels = obligations(readFileSync(join(dirname(path),config), 'utf8')).filter(name => /^Never[A-Za-z_0-9]*$/.test(name));
      if (!sentinels.length) errors.push(`${key}: probe has no sentinel ${config}`);
      for (const expected of sentinels) {
        if (!entries.some(entry => entry.kind === 'reachability' && entry.config === config && entry.expected === expected)) errors.push(`${key}: unregistered probe ${config}: ${expected}`);
      }
    }
    for (const entry of entries) {
      if (entry.kind === 'reachability') {
        if (!probes.includes(entry.config) || !/^Never[A-Za-z_0-9]*$/.test(entry.expected) || !obligations(readFileSync(join(dirname(path),entry.config), 'utf8')).includes(entry.expected)) errors.push(`${key}: invalid reachability control ${entry.config}`);
      } else if (!names.includes(entry.expected) || !/-unsafe[^/]*\.cfg$/.test(entry.config) || !existsSync(join(dirname(path),entry.config))) errors.push(`${key}: invalid negative control ${entry.config}`);
    }
    models.push({path:key, cfgs, names, missing, controls:entries});
  }
  for (const key of [...Object.keys(allowlist),...Object.keys(controls)]) if (!models.some(model => model.path === key)) errors.push(`${key}: stale model inventory entry`);
  return {models,errors};
}

export function changedModelInventory({root = '.'} = {}) {
  const git = (...args) => {
    const result = spawnSync('git', args, {cwd:root,encoding:'utf8',timeout:10000,maxBuffer:4 * 1024 * 1024});
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr || 'model inventory requires fetched origin/main');
    return result.stdout;
  };
  const changed = new Set([
    ...git('diff','--name-only','--diff-filter=ACMR','-z','origin/main','--','*.tla').split('\0'),
    ...git('ls-files','--others','--exclude-standard','-z','--','*.tla').split('\0'),
  ].filter(Boolean));
  if (!changed.size) return {models:[],errors:[]};
  const audit = auditModels({root});
  const errors = [...audit.errors];
  if (root !== '.') {
    const previous = JSON.parse(git('show','origin/main:config/model-negative-controls.allowlist.v1.json'));
    const current = JSON.parse(readFileSync(join(root,'config/model-negative-controls.allowlist.v1.json'),'utf8'));
    errors.push(...allowlistGrowth(previous,current));
  }
  for (const path of changed) {
    if (!audit.models.some(model => model.path === path)) errors.push(
      `${path}: added/changed model has no auditable safe configuration`);
  }
  return {models:audit.models.filter(model => changed.has(model.path)),
    errors:[...new Set(errors)].map(error => `${error}; edit config/model-negative-controls.v1.json`)};
}

export function negativeResultMatches(control, run, configText = '') {
  if (control.kind === 'property') {
    const properties = obligations(configText, 'property');
    return properties.length === 1 && properties[0] === control.expected
      && obligations(configText, 'invariant').length === 0
      && run.status === 13 && run.stdout.includes('Temporal properties were violated')
      && run.stdout.includes('Error: The following behavior constitutes a counter-example:')
      && /^State \d+: /m.test(run.stdout);
  }
  return run.status === 12 && run.stdout.includes(`Invariant ${control.expected} is violated`);
}

export function withStatusUnchanged(status, operation) {
  const before = status();
  const failures = [];
  let result;
  try { result = operation(); } catch (error) { failures.push(error); }
  try { if (status() !== before) throw new Error('TLC changed repository status'); }
  catch (error) { failures.push(error); }
  if (failures.length > 1) throw new AggregateError(failures, failures.map(error => error.message).join('; '), {cause: failures[0]});
  if (failures.length === 1) throw failures[0];
  return result;
}

export function verifyControls(audit = auditModels()) {
  if (audit.errors.length) throw new Error(audit.errors.join('\n'));
  const status = () => execFileSync('git',['status','--porcelain','--untracked-files=all'],{encoding:'utf8'});
  const results = [];
  return withStatusUnchanged(status, () => {
    const jobs=[];
    for (const model of audit.models.filter(model => model.controls.length)) {
      for (const config of model.cfgs) jobs.push({id:`${model.path}/safe/${config}`,source:dirname(model.path),model:basename(model.path),config,expectedStatus:0,path:model.path});
      for (const [index,control] of model.controls.entries()) jobs.push({id:`${model.path}/control/${index}/${control.expected}`,source:dirname(model.path),model:basename(model.path),config:control.config,expectedStatus:control.kind==='property'?13:12,path:model.path,control});
    }
    const runs=jobs.length?runTlcBatch(jobs):[];
    for (const [index,job] of jobs.entries()) {
      const run=runs[index];
      if (!job.control) {
        if (run.skipped || run.status !== 0) throw new Error(`${job.path}/${job.config}: safe TLC did not pass: ${run.reason ?? run.stdout + run.stderr}`);
      } else if (run.skipped || !negativeResultMatches(job.control, run, readFileSync(join(job.source,job.config), 'utf8'))) throw new Error(`${job.path}/${job.config}: intended negative result absent: ${run.reason ?? run.stdout + run.stderr}`);
      results.push({...run,model:job.path,config:job.config});
    }
    return results;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const audit = process.argv.includes('--changed') ? changedModelInventory() : auditModels();
    if (audit.errors.length) throw new Error(audit.errors.join('\n'));
    if (process.argv.includes('--run')) console.log(JSON.stringify(verifyControls(audit),null,2));
    console.log(`negative controls: ${audit.models.length} models; ${audit.models.filter(model => model.missing.length).length} historical exceptions`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
