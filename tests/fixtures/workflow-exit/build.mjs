import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { after } from 'node:test';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initial } from '../../../scripts/workflow_runner_core.mjs';
export const sha = value => createHash('sha256').update(value).digest('hex');
let seed;
const seedRoots = [];
after(() => { for (const repo of seedRoots) rmSync(repo, { recursive: true, force: true }); });
function makeSeed() {
  const parent = resolve('.scratch/workflow-exit-tests'); mkdirSync(parent, { recursive: true });
  const repo = mkdtempSync(join(parent, 'seed-')); seedRoots.push(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'fixture'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, '.gitignore'), '.local/\n.scratch/\n');
  writeFileSync(join(repo, 'skill.md'), '## Step: check\n');
  writeFileSync(join(repo, 'check.mjs'), "console.log('# tests 1');\n");
  const manifest = JSON.parse(readFileSync(new URL('../workflow-spec/spec.json', import.meta.url), 'utf8'));
  for (const file of ['SPEC.tla', 'SPEC.cfg', 'SPEC-unsafe-skip.cfg', 'SPEC.view.mjs', 'chart.mmd']) writeFileSync(join(repo, file), readFileSync(new URL(`../workflow-spec/${file}`, import.meta.url)));
  manifest.checks = { invariantWhen: 'g8', add: [{ id: 'inv', kind: 'invariant-test', covers: [manifest.invariants[0].id], command: ['node', 'check.mjs'], counter: 'node-tap' }] };
  writeFileSync(join(repo, 'spec.json'), JSON.stringify(manifest));
  mkdirSync(join(repo, '.driver')); const defaults = { schema: 'pad-exit-checks.v1', fromGateRules: [], defaults: [{ id: 'lint', kind: 'lint', command: ['node', 'check.mjs'] }] };
  writeFileSync(join(repo, '.driver/exit-checks.json'), JSON.stringify(defaults));
  writeFileSync(join(repo, '.driver/gate-rules.json'), JSON.stringify({ checks: [{ id: 'reviewed', kind: 'command', command: ['node', 'check.mjs'] }] }));
  git('add', '.'); git('commit', '-m', 'fixture declaration'); const revision = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'artifact.md'), 'after'); git('add', '.'); git('commit', '-m', 'fixture receipt'); const commit = git('rev-parse', 'HEAD');
  return { repo, revision, commit, manifest, defaults };
}
export function fixture(t) {
  // Reuse static Git arrangement only, never journals, authority or observations.
  seed ??= makeSeed();
  const repo = mkdtempSync(join(resolve('.scratch/workflow-exit-tests'), 'case-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  cpSync(seed.repo, repo, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const { revision, commit } = seed, manifest = structuredClone(seed.manifest), defaults = structuredClone(seed.defaults);
  const w = { schema: 'pad-workflow.v1', repo, revision, maxAttempts: 1,
    spec: { schema: 'pad-workflow-spec-ref.v1', manifest: 'spec.json', sha256: sha(JSON.stringify(manifest)) },
    steps: [{ id: 'build', artifact: 'artifact.md', sha256: sha('after'), skill: { pack: 'synthetic', version: 'v1', path: 'skill.md', sha256: sha('## Step: check\n'), step: 'check' }, worker: { schema: 'pad-worker.v1', role: 'builder', model: 'synthetic-route', repository: 'synthetic-repo' } }] };
  const s = initial(w); s.phase = 'awaiting'; s.taskId = 'task'; s.attempts = [1];
  s.intent = { taskId: 'task', stepId: 'build', dispatchId: 'dispatch-fixture', epoch: s.epoch, writerId: s.writerId, base: revision, branch: 'fixture', ack: true };
  s.pending = { stepId: 'build', dispatchId: s.intent.dispatchId, epoch: s.epoch, writerId: s.writerId, stepBaseHead: revision, commit };
  s.spec = { verdict: 'pass', manifestSha256: w.spec.sha256, chartSha256: null, confirmedChartSha256: null, derived: { harness: { kind: 'pi' } } };
  const binding = { taskId: 'task', stepId: 'build', epoch: s.epoch, writerId: s.writerId, dispatchId: s.intent.dispatchId, commit, checksDigest: 'a'.repeat(64) };
  const request = { repo, commit, binding, checks: [...defaults.defaults, ...manifest.checks.add], manifest, runner: 'host', pickedBy: 'requested', progress: { noProgressLimit: 3, safetyCeiling: 50 }, previous: null };
  const show = (rev, path) => git('show', `${rev}:${path}`);
  return { repo, git, w, s, commit, binding, manifest, defaults, request, show };
}
