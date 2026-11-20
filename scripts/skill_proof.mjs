// SPDX-License-Identifier: AGPL-3.0-only
// Live, local model proof for guidance-only skills. No package installs or outward writes.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  model: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, only: { type: 'string' },
} });
const model = values.model ?? process.env.SKILL_PROOF_MODEL;
if (!model) throw new Error('select an explicit model with --model or SKILL_PROOF_MODEL');
const log = values.json ? () => {} : console.log;
const root = resolve(import.meta.dirname, '..');
const map = JSON.parse(readFileSync(resolve(root, 'config/skill-proof.v1.json'), 'utf8')).skills;
const entries = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).pi.skills;
const only = values.only ?? process.env.SKILL_PROOF_ONLY;
if (only && (map[only]?.kind !== 'behavior' || !entries.some(entry => entry.split('/').at(-1) === only))) {
  throw new Error(`skill not registered for behavior proof: ${only}`);
}
const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const skills = Object.fromEntries(entries.map(entry => [entry.split('/').at(-1), digest(resolve(root, entry, 'SKILL.md'))]));
const evidenceDir = resolve(root, values.out ?? '.driver/skill-proof-evidence');
mkdirSync(evidenceDir, { recursive: true });
const evidenceFile = resolve(evidenceDir, 'runs.jsonl');
const cases = [];
const runsPerCondition = Number(process.env.SKILL_PROOF_TRIAL_RUNS ?? 3);
if (![1, 3].includes(runsPerCondition)) throw new Error('trial runs must be 1 or 3');
let failed = Boolean(only || runsPerCondition !== 3);
for (const [name, proof] of Object.entries(map)) {
  if (proof.kind !== 'behavior' || (only && only !== name)) continue;
  const directory = resolve(root, 'tests/skill-proof', name);
  const data = JSON.parse(readFileSync(resolve(directory, 'case.json'), 'utf8'));
  const skill = resolve(root, 'skills', name, 'SKILL.md');
  const results = [];
  for (const loaded of [false, true]) {
    for (let run = 1; run <= runsPerCondition; run++) {
      const prompt = loaded ? `/skill:${name} ${data.prompt}` : data.prompt;
      const args = ['--print', '--model', model, '--no-session', '--no-context-files', '--no-extensions', '--no-mcp', '--no-tools', '--no-skills', '--no-prompt-templates'];
      if (loaded) args.push('--skill', skill);
      args.push('--', prompt);
      const outcome = spawnSync('pi', args, { cwd: directory, encoding: 'utf8', timeout: 240000, maxBuffer: 1024 * 1024 });
      const output = outcome.stdout ?? '';
      const matches = data.mustInclude.map(pattern => new RegExp(pattern.replace(/\(\?i\)/g, ''), 'im').test(output));
      const passed = outcome.status === 0 && matches.every(Boolean);
      const record = { case: name, run, loaded, pass: passed, exit: outcome.status, error: String(outcome.error?.message ?? ''), matches,
        outputDigest: createHash('sha256').update(output).digest('hex'), output: output.slice(0, 4096), stderr: (outcome.stderr ?? '').slice(0, 4096), skillDigest: skills[name], headSha, model };
      appendFileSync(evidenceFile, JSON.stringify(record) + '\n');
      results.push(record);
      log(`${name} ${loaded ? 'with-skill' : 'without-skill'} ${run}/3: ${passed ? 'assertions pass' : 'assertions fail'}${outcome.error ? ` (${outcome.error.message})` : ''}`);
    }
  }
  const control = results.filter(r => !r.loaded);
  const trial = results.filter(r => r.loaded);
  const summary = { skill: name, passRuns: trial.filter(r => r.pass).length, failFirst: control.every(r => !r.pass), runs: results.length };
  cases.push(summary);
  if (!summary.failFirst || summary.passRuns !== 3) failed = true;
}
const summary = { schema: 'pi-agentic-driver.skill-proof.v1', status: failed ? 'fail' : 'pass', headSha, model, skills, cases };
writeFileSync(resolve(evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (failed) process.exitCode = 1;
