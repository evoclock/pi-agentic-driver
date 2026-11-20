// SPDX-License-Identifier: AGPL-3.0-only
// Fake-only R5-3 control: copies the source to os.tmpdir and never invokes a candidate executable.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const source = readFileSync(join(root, 'scripts/enforcement/codex_spawn_pi.js'), 'utf8');
const start = source.indexOf('function codexExecutable(token, expected, launcher, root) {');
const end = source.indexOf('\n// The production helper returns one key only;', start);
if (start < 0 || end <= start || source.indexOf('function codexExecutable(token, expected, launcher, root) {', start + 1) !== -1) {
  throw new Error('R5-3 mutation target not unique');
}
const scratch = mkdtempSync(join(tmpdir(), 'pad-r53-mutation-'));
try {
  const copied = join(scratch, 'codex_spawn_pi.mjs');
  const env = { ...process.env, PAD_CODEX_BINARY_SOURCE: copied, PI_CODING_AGENT_DIR: join(scratch, 'profile') };
  const run = () => spawnSync(process.execPath, ['--test', join(root, 'tests/test_codex_binary_identity.mjs')],
    { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  writeFileSync(copied, source);
  const control = run();
  if (control.status !== 0 || control.error || !control.stdout.includes('# pass 14')) {
    throw new Error('unmutated binary copy did not pass');
  }
  console.log('binary copy-control passed: 14/14');
  writeFileSync(copied, source.slice(0, start)
    + 'function codexExecutable(token, expected) { return typeof token === "string" && token.split("/").pop() === "codex"; }\n'
    + source.slice(end));
  const mutant = run();
  if (mutant.status === 0 || mutant.error || !mutant.stdout.includes('not ok ')) {
    throw new Error('name-only binary mutant survived or failed to load');
  }
  console.log('name-only binary mutant killed by fake look-alike tests');
  const check = 'root ? !insideReleaseRoot(target, root) : target !== expected';
  if (source.split(check).length !== 2) throw new Error('root containment mutation target not unique');
  writeFileSync(copied, source.replace(check, 'root ? !target.endsWith("/bin/codex") : target !== expected'));
  const rootMutant = run();
  if (rootMutant.status === 0 || rootMutant.error || !rootMutant.stdout.includes('not ok ')
      || !rootMutant.stdout.includes('configured native binary outside release root refuses')) {
    throw new Error('root prefix mutant survived or failed to load');
  }
  console.log('root prefix mutant killed by fake root-escape test');
} finally { rmSync(scratch, { recursive: true, force: true }); }
