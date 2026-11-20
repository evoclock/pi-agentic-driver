import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const skills = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).pi.skills;

// Why: the decision workflow must ship with its model and keep the autonomous boundary explicit.
test('decision-gate ships a formal decision workflow', () => {
  const manifest = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }))[0];
  for (const name of ['SKILL.md', 'DecisionGate.tla', 'DecisionGate.cfg', 'DecisionGate-unsafe-owner.cfg', 'DecisionGate-unsafe-record.cfg', 'DecisionGate-unsafe-enforce.cfg']) {
    assert.ok(manifest.files.some(file => file.path === 'skills/decision-gate/' + name), name);
  }
  assert.ok(skills.includes('./skills/decision-gate'));
  const text = readFileSync(resolve(root, 'skills/decision-gate/SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: decision-gate\ndescription: .+\n---\n/);
  assert.match(text, /statechart-pi.*pi-poteto-mode/);
  const exclusions = text.split('## Owner-only exclusions')[1].split('## Missing tooling')[0];
  for (const term of ['hold', 'merges', 'undraft', 'tag', 'release', 'public mirror sync', 'repo forwarding', 'wording or naming changes', 'npm publish', 'deploy', 'force-push', 'rebase', 'CI-limit', 'gate-cap', 'credential access']) assert.ok(exclusions.includes(term), term);
  const proof = JSON.parse(readFileSync(resolve(root, 'config/skill-proof.v1.json'))).skills['decision-gate'];
  assert.equal(proof.kind, 'code');
  assert.match(proof.acceptance, /behavior.*unconfigured/);
  assert.match(readFileSync(resolve(root, 'README.md'), 'utf8'), /decision-gate.*behavior proof gap/);
});

// Why: a negative model must expose the intended boundary failure, not merely fail to parse.
test('decision-gate TLC safe and unsafe configurations', t => {
  const probe = execFileSync('sh', ['-c', 'command -v tlc || true'], { encoding: 'utf8' }).trim();
  const jar = process.env.TLA2TOOLS;
  if (!probe && !jar) return t.skip('TLC not run: tlc unavailable on PATH and TLA2TOOLS unset');
  const executable = jar ? (process.env.JAVA || 'java') : probe;
  const prefix = jar ? ['-cp', jar, 'tlc2.TLC'] : [];
  mkdirSync(resolve(root, '.scratch'), { recursive: true });
  const cwd = mkdtempSync(resolve(root, '.scratch/decision-tlc-'));
  cpSync(resolve(root, 'skills/decision-gate'), cwd, { recursive: true });
  prefix.push('-workers', '1', '-metadir', resolve(cwd, 'meta'));
  const safe = spawnSync(executable, [...prefix, '-config', 'DecisionGate.cfg', 'DecisionGate.tla'], { cwd, encoding: 'utf8', timeout: 60000 });
  assert.equal(safe.status, 0, safe.stdout + safe.stderr);
  assert.match(safe.stdout, /Model checking completed. No error has been found/);
  for (const [variant, invariant] of [['owner', 'OwnerBoundary'], ['record', 'RecordedBeforeProceed'], ['enforce', 'EnforcedBeforeProceed']]) {
    const unsafe = spawnSync(executable, [...prefix, '-config', `DecisionGate-unsafe-${variant}.cfg`, 'DecisionGate.tla'], { cwd, encoding: 'utf8', timeout: 60000 });
    assert.equal(unsafe.status, 12, unsafe.stdout + unsafe.stderr);
    assert.ok(unsafe.stdout.includes(`Invariant ${invariant} is violated`));
  }
});

// Why: every shipped skill needs one readable workflow and an explicit enforcement boundary.
test('each registered skill has an opening, numbered steps and one Limits section', () => {
  for (const skill of skills) {
    if (skill.endsWith('/release-public')) continue; // Private-only release procedure.
    const text = readFileSync(resolve(root, skill, 'SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    assert.match(text, /^# [^\n]+\n\n[^#\n][^\n]+/m, skill);
    assert.match(text, /^1\. /m, skill);
    assert.equal((text.match(/^## Limits$/gm) ?? []).length, 1, skill);
    assert.doesNotMatch(text, /this slice|not installed|before merge|candidate|rollout step|\(P\d+\)/i, skill);
  }
});
