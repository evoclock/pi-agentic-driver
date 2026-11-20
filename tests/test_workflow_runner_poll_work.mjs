import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../scripts/workflow_runner_core.mjs';
import { createFakeAuthority } from '../scripts/workflow_runner_authority.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'poll-work-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'evoclock'); git('config', 'user.email', '52983349+evoclock@users.noreply.github.com');
  mkdirSync(join(repo, 'skills')); const skill = '# Skill\n## step: check\nCheck synthetic content.\n';
  writeFileSync(join(repo, 'skills/check.md'), skill); writeFileSync(join(repo, 'artifact.md'), 'before');
  git('add', '.'); git('commit', '-qm', 'fixture');
  return { repo, store: join(repo, '.local/workflow-runner/task0001'),
    authority: createFakeAuthority({ tenantId: 'tenant_0001', taskId: 'task_000001' }),
    w: { schema: 'pad-workflow.v1', repo, revision: git('rev-parse', 'HEAD'), maxAttempts: 2,
      steps: [{ id: 'check', artifact: 'artifact.md', sha256: sha('after'),
        skill: { pack: 'synthetic', version: 'v1', path: 'skills/check.md', sha256: sha(skill), step: 'check' } }] } };
}
// Why: the private cache executor receives the already validated contract; validating it twice multiplies every bounded poll's Git work.
test('one poll validates its workflow exactly once at the public boundary', async t => {
  const f = fixture(t), originalPath = process.env.PATH, originalLog = process.env.PAD_TEST_GIT_LOG;
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(f.repo, 'bin'), log = join(f.repo, 'git.log'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PAD_TEST_GIT_LOG"\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o700 });
  try {
    process.env.PATH = `${bin}:${originalPath}`; process.env.PAD_TEST_GIT_LOG = log;
    assert.equal((await run(f.w, f.store, { id: 'look', type: 'look' }, { authority: f.authority })).move, 'wait');
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.PAD_TEST_GIT_LOG; else process.env.PAD_TEST_GIT_LOG = originalLog;
  }
  const validations = readFileSync(log, 'utf8').split('\n').filter(line => line.endsWith('rev-parse --show-toplevel'));
  assert.equal(validations.length, 1);
});
// Why: fresh authority reads remain mandatory, but an unchanged high-water observation has no new durable fact to fsync.
test('unchanged authority polls keep the durable high-water record without rewriting it', async t => {
  const f = fixture(t); let reads = 0, file, duringSecondPoll;
  const read = f.authority.readEpoch;
  f.authority.readEpoch = () => { reads++; if (reads === 4) duringSecondPoll = statSync(file).ino; return read(); };
  await run(f.w, f.store, { id: 'first', type: 'look' }, { authority: f.authority });
  const dir = join(f.repo, '.local/workflow-runner/.authority-cache');
  file = join(dir, readdirSync(dir).find(name => name.endsWith('.json')));
  const inode = statSync(file).ino;
  await run(f.w, f.store, { id: 'second', type: 'look' }, { authority: f.authority });
  assert.equal(reads, 4, 'both boundary reads remain fresh on every poll');
  assert.equal(duringSecondPoll, inode, 'no redundant atomic replacement between unchanged observations');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).seq, 0);
});
// Why: missing evidence must remain a hard failure with main's simplified envelope decoder.
test('missing observability envelope is a hard failure', t => {
  if (!existsSync(new URL('../scripts/ci-observability.sh', import.meta.url))) {
    t.skip('private observability script is not in this checkout');
    return;
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'obs-decode-')));
  t.after(() => rmSync(dir, { recursive: true, force: true })); writeFileSync(join(dir, 'target.log'), '');
  const script = readFileSync(new URL('../scripts/ci-observability.sh', import.meta.url), 'utf8');
  const matches = [...script.matchAll(/python3 - "\$area"[^\n]*<<'PY'\n([\s\S]*?)\nPY/g)];
  assert.equal(matches.length, 1);
  const output = spawnSync('python3', ['-', dir], { input: matches[0][1], encoding: 'utf8' });
  assert.equal(output.status, 1); assert.match(output.stderr, /missing single bounded evidence envelope/);
});
